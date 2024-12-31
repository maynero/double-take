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

const uploadImage = async (file) => {
  const formData = new FormData();
  formData.append('assetData', fs.createReadStream(file));
  formData.append('deviceId', 'double-take');
  formData.append('deviceAssetId', `double-take-${randomUUID()}`);
  formData.append('fileCreatedAt', '1999-01-01T00:00:00.000Z');
  formData.append('fileModifiedAt', '1999-01-01T00:00:00.000Z');

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
  });
};

function sleep(time) {
  return new Promise((resolve) => {
    setTimeout(resolve, time);
  });
}

const recognize = async ({ key }) => {
  const asset = await uploadImage(key);
  await sleep(5000);
  const faces = await getFaces(asset.data.id);
  const [face] = faces.data;
  let confidence = 0;
  let userId = '';

  if (face.person) {
    confidence = 1;
    userId = face.person.name;
  }

  return {
    data: {
      status: 200,
      success: true,
      predictions: [
        {
          confidence,
          userid: userId,
          x_min: face.boundingBoxX1,
          y_min: face.boundingBoxY1,
          x_max: face.boundingBoxX2,
          y_max: face.boundingBoxY2,
        },
      ],
    },
  };
};

const train = async ({ name, key }) => {
  let face;
  let person;
  const asset = await uploadImage(key);

  // Faces are determined automatically
  // Retry the API call until faces are detected
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

  const persons = await getPersons(name);

  if (persons.data.length >= 1) {
    [person] = persons.data;
  } else {
    person = (await createPerson(name)).data;
  }

  await assignFace(face.id, person.id);

  return asset;
};

const remove = ({ ids = [] }) => {
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

  if (faceIds.length) return deleteAssets(faceIds);
};

const normalize = ({ camera, data }) => {
  if (!data.success) {
    if (data.code === 500 && data.error === 'No face found in image') {
      console.log('immich machine learning found no face in the image');
      return [];
    }
    console.warn('unexpected ai.server data');
    return [];
  }
  const { MATCH, UNKNOWN } = config.detect(camera);
  if (!data.predictions) {
    console.warn('unexpected ai.server predictions data');
    return [];
  }
  const normalized = data.predictions.flatMap((obj) => {
    const confidence = parseFloat((obj.confidence * 100).toFixed(2));
    obj.userid = obj.userid ? obj.userid : obj.plate ? obj.plate : 'unknown';
    const output = {
      name: confidence >= UNKNOWN.CONFIDENCE ? obj.userid.toLowerCase() : 'unknown',
      confidence,
      match:
        obj.userid !== 'unknown' &&
        confidence >= MATCH.CONFIDENCE &&
        (obj.x_max - obj.x_min) * (obj.y_max - obj.y_min) >= MATCH.MIN_AREA,
      box: {
        top: obj.y_min,
        left: obj.x_min,
        width: obj.x_max - obj.x_min,
        height: obj.y_max - obj.y_min,
      },
    };
    const checks = actions.checks({ MATCH, UNKNOWN, ...output });
    if (checks.length) output.checks = checks;
    return checks !== false ? output : [];
  });
  return normalized;
};
module.exports = { recognize, train, remove, normalize };
