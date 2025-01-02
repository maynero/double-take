const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { randomUUID } = require('crypto');
const actions = require('./actions');
const database = require('../db.util');
const { DETECTORS } = require('../../constants')();
const config = require('../../constants/config');

const { IMMICH } = DETECTORS || {};

function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
}

const generateHeaders = () => {
  return {
    Accept: 'application/json',
    'x-api-key': IMMICH.KEY,
  };
};

const getJobStatus = async () => {
  console.verbose('immich: getJobStatus');
  const response = await axios({
    method: 'get',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/jobs`,
    headers: {
      ...generateHeaders(),
    },
  });

  return response.data;
};

const runJob = async (jobName) => {
  console.verbose('immich: runJob');
  let job = await getJobStatus();

  if (!job[jobName].queueStatus.isActive) {
    console.verbose(`immich: Running ${jobName} job...`);
    const newJob = await axios({
      method: 'put',
      timeout: IMMICH.TIMEOUT * 1000,
      url: `${IMMICH.URL}/api/jobs/${jobName}`,
      headers: {
        ...generateHeaders(),
      },
      data: {
        command: 'start',
        force: false,
      },
    });
    job[jobName] = newJob.data;
  }

  let retry = 1;
  while (job[jobName].queueStatus.isActive) {
    console.verbose(`immich: waiting for ${jobName} job to finish...`);
    await sleep(1000);
    job = await getJobStatus();

    if (retry >= IMMICH.MAX_RETRIES) {
      break;
    }

    retry++;
  }

  if (job[jobName].queueStatus.isActive) {
    console.warn(`immich: ${jobName} job did not finish in ${IMMICH.MAX_RETRIES} retries`);
  }
};

const uploadAsset = async (file, dateGroup) => {
  console.verbose('immich: uploadAsset');
  const formData = new FormData();
  formData.append('assetData', fs.createReadStream(file));
  formData.append('deviceId', 'double-take');
  formData.append('deviceAssetId', `double-take-${randomUUID()}`);
  formData.append('fileCreatedAt', dateGroup);
  formData.append('fileModifiedAt', dateGroup);

  const response = await axios({
    method: 'post',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/assets`,
    headers: {
      ...formData.getHeaders(),
      ...generateHeaders(),
    },
    data: formData,
    maxContentLength: 100000000,
    maxBodyLength: 1000000000,
  });

  if (response.data.status !== 'created') {
    console.warn(`immich uploadAsset status: ${response.data.status}`);
  }

  return response.data;
};

const getFaces = async (assetId) => {
  console.verbose('immich: getFaces');
  const response = await axios({
    method: 'get',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/faces`,
    params: { id: assetId },
    headers: {
      ...generateHeaders(),
    },
  });
  await runJob('library');
  return response.data;
};

const getPersons = async (name) => {
  console.verbose('immich: getPersons');
  const response = await axios({
    method: 'get',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/search/person`,
    params: {
      name,
      withHidden: true,
    },
    headers: {
      ...generateHeaders(),
    },
  });

  return response.data;
};

const createPerson = async (name) => {
  console.verbose('immich: createPerson');
  const response = await axios({
    method: 'post',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/people`,
    headers: {
      ...generateHeaders(),
    },
    data: {
      name,
    },
  });

  return response.data;
};

const assignFace = (faceId, personId) => {
  console.verbose('immich: assignFace');
  return axios({
    method: 'put',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/faces/${personId}`,
    headers: {
      ...generateHeaders(),
    },
    data: {
      id: faceId,
    },
  });
};

const deleteAssets = async (assetIds) => {
  console.verbose('immich: deleteAssets');
  console.debug(`Deleting assets: ${assetIds}`);
  try {
    await axios({
      method: 'delete',
      timeout: IMMICH.TIMEOUT * 1000,
      url: `${IMMICH.URL}/api/assets`,
      headers: {
        ...generateHeaders(),
      },
      data: {
        force: true,
        ids: assetIds,
      },
    });
    await runJob('library');
  } catch (error) {
    console.warn(`Unable to delete: ${error.message}`);
  }
};

const recognize = async ({ key }) => {
  console.verbose('immich: recognize');
  const asset = await uploadAsset(key, IMMICH.RECOGNIZE_DATE_GROUP);
  await runJob('faceDetection');
  await runJob('facialRecognition');
  const faces = await getFaces(asset.id);

  // Delete the image in immich after identifying the face
  if (IMMICH.DELETE_ON_RECOGNIZE) await deleteAssets([asset.id]);

  return {
    data: faces,
  };
};

const train = async ({ name, key }) => {
  console.verbose('immich: train');
  const asset = await uploadAsset(key, IMMICH.TRAIN_DATE_GROUP);
  await runJob('faceDetection');
  await runJob('facialRecognition');
  const faces = await getFaces(asset.id);

  for (const face of faces) {
    let [person] = await getPersons(name);

    if (!person) {
      person = await createPerson(name);
    }

    await assignFace(face.id, person.id);
  }

  if (faces.length) {
    return {
      status: 200,
      data: asset,
    };
  }

  return {
    status: 500,
    data: {
      id: asset.id,
      error: 'No face found in the image',
    },
  };
};

const remove = async ({ ids = [] }) => {
  console.verbose('immich: remove');
  const db = database.connect();
  const assetIds = !ids.length
    ? db
        .prepare(
          `SELECT name, json_extract(meta, '$.id') assetId
           FROM train`
        )
        .all()
        .map((obj) => obj.assetId)
    : db
        .prepare(
          `SELECT name, json_extract(meta, '$.id') assetId
          FROM train
          WHERE fileId IN (${database.params(ids)})`
        )
        .all(ids)
        .map((obj) => obj.assetId);

  if (assetIds.filter((id) => id).length) {
    await deleteAssets(assetIds);
  }
};

const normalize = ({ camera, data }) => {
  if (!data.length) {
    console.log('immich found no face in the image');
    return [];
  }

  const { MATCH, UNKNOWN } = config.detect(camera);
  const normalized = data.flatMap((obj) => {
    obj.userid = obj.person ? (obj.person.name ? obj.person.name : 'unknown') : 'unknown';
    const confidence = obj.userid !== 'unknown' ? 100 : 0;
    const output = {
      name: confidence >= UNKNOWN.CONFIDENCE ? obj.userid.toLowerCase() : 'unknown',
      confidence,
      match:
        obj.userid !== 'unknown' &&
        confidence >= MATCH.CONFIDENCE &&
        (obj.boundingBoxX2 - obj.boundingBoxX1) * (obj.boundingBoxY2 - obj.boundingBoxY1) >=
          MATCH.MIN_AREA,
      box: {
        top: obj.boundingBoxY1,
        left: obj.boundingBoxX1,
        width: obj.boundingBoxX2 - obj.boundingBoxX1,
        height: obj.boundingBoxY2 - obj.boundingBoxY1,
      },
    };
    const checks = actions.checks({ MATCH, UNKNOWN, ...output });
    if (checks.length) output.checks = checks;
    return checks !== false ? output : [];
  });

  return normalized;
};

module.exports = { recognize, train, remove, normalize };
