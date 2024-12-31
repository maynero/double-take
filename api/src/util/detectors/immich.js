const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const { randomUUID } = require('crypto');
const actions = require('./actions');
const database = require('../db.util');
const { DETECTORS } = require('../../constants')();
const config = require('../../constants/config');

const { IMMICH } = DETECTORS || {};

const generateHeaders = () => {
  return {
    Accept: 'application/json',
    'x-api-key': IMMICH.KEY,
  };
};

const uploadImage = async (file, dateGroup) => {
  const formData = new FormData();
  formData.append('assetData', fs.createReadStream(file));
  formData.append('deviceId', 'double-take');
  formData.append('deviceAssetId', `double-take-${randomUUID()}`);
  formData.append('fileCreatedAt', dateGroup);
  formData.append('fileModifiedAt', dateGroup);

  const requestConfig = {
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
  };

  return axios.request(requestConfig);
};

const getFaces = (assetId) => {
  return axios({
    method: 'get',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/faces`,
    params: {
      id: assetId,
    },
    headers: {
      ...generateHeaders(),
    },
  });
};

const getPersons = async (name) => {
  return axios({
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
};

const createPerson = async (name) => {
  return axios({
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
};

const assignFace = async (faceId, personId) => {
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

const deleteAssets = async (faceIds) => {
  return axios({
    method: 'delete',
    timeout: IMMICH.TIMEOUT * 1000,
    url: `${IMMICH.URL}/api/assets`,
    headers: {
      ...generateHeaders(),
    },
    data: {
      force: true,
      ids: faceIds,
    },
  }).catch((e) => {
    console.warn(`Unable to delete: ${e.message}`);
  });
};

function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
}

const recognize = async ({ key }) => {
  let faces;
  const asset = await uploadImage(key, IMMICH.RECOGNIZE_DATE_GROUP);
  await sleep(5000);

  for (let i = 0; i < 10; i++) {
    faces = await getFaces(asset.data.id);

    if (faces.data.length >= 1) {
      break;
    }

    // Wait 1000ms before retrying
    await sleep(1000);
  }

  // Delete the image in immich after identifying the face
  if (IMMICH.DELETE_ON_RECOGNIZE) await deleteAssets([asset.data.id]);

  return faces;
};

const train = async ({ name, key }) => {
  let face;
  let person;
  const asset = await uploadImage(key, IMMICH.TRAIN_DATE_GROUP);

  // Faces are determined automatically
  // Retry API call until faces are detected
  for (let i = 0; i < 10; i++) {
    const faces = await getFaces(asset.data.id);

    if (faces.data.length >= 1) {
      [face] = faces.data;
      break;
    }

    // Wait 1000ms before retrying
    await sleep(1000);
  }

  // Add handling if no face detected
  if (face) {
    const persons = await getPersons(name);

    if (persons.data.length >= 1) {
      [person] = persons.data;
    } else {
      person = (await createPerson(name)).data;
    }

    await assignFace(face.id, person.id);
    return asset;
  }

  return {
    status: 500,
    data: {
      id: asset.data.id,
      error: 'No face found in the image',
    },
  };
};

const remove = async ({ ids = [] }) => {
  const db = database.connect();
  const faceIds = !ids.length
    ? db
        .prepare(
          `SELECT name, json_extract(meta, '$.id') faceId
           FROM train`
        )
        .all()
        .map((obj) => obj.faceId)
    : db
        .prepare(
          `SELECT name, json_extract(meta, '$.id') faceId
          FROM train
          WHERE fileId IN (${database.params(ids)})`
        )
        .all(ids)
        .map((obj) => obj.faceId);

  if (faceIds.length) await deleteAssets(faceIds);
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
