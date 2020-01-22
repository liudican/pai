// Copyright (c) Microsoft Corporation
// All rights reserved.
//
// MIT License
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and
// to permit persons to whom the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED *AS IS*, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
// BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
// NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// module dependencies
const _ = require('lodash');
const crypto = require('crypto');
const {isNil} = require('lodash');

const {convertToJobAttempt} = require('@pai/utils/frameworkConverter');
const launcherConfig = require('@pai/config/launcher');
const createError = require('@pai/utils/error');
const k8sModel = require('@pai/models/kubernetes/kubernetes');
const logger = require('@pai/config/logger');
const { sequelize } = require('@pai/utils/postgresUtil');

const convertName = (name) => {
  // convert framework name to fit framework controller spec
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
};

const encodeName = (name) => {
  if (name.startsWith('unknown') || !name.includes('~')) {
    // framework is not generated by PAI
    return convertName(name.replace(/^unknown/g, ''));
  } else {
    // md5 hash
    return crypto.createHash('md5').update(name).digest('hex');
  }
};

if (sequelize){
  const healthCheck = async () => {
    try {
      await sequelize.authenticate();
      return true;
    } catch(e) {
      logger.error(e.message);
      return false;
    }
  };

  const list = async (frameworkName) => {
    let attemptData = [];
    let uid;

    // get latest framework from k8s API
    let response;
    try {
      response = await k8sModel.getClient().get(
        launcherConfig.frameworkPath(encodeName(frameworkName)),
        {
          headers: launcherConfig.requestHeaders,
        }
      );
    } catch (error) {
      logger.error(`error when getting framework from k8s api: ${error.message}`);
      if (error.response != null) {
        response = error.response;
      } else {
        throw error;
      }
    }

    if (response.status === 200) {
      // get UID from k8s framework API
      uid = response.data.metadata.uid;
      attemptData.push({
        ...(await convertToJobAttempt(response.data)),
        isLatest: true,
      });
    } else if (response.status === 404) {
      logger.warn(`could not get framework ${uid} from k8s: ${JSON.stringify(response)}`);
      return {status: 404, data: null};
    } else {
      throw createError(response.status, 'UnknownError', response.data.message);
    }

    if (isNil(uid)) {
      return {status: 404, data: null};
    }

    const sqlSentence = `SELECT (record->'objectSnapshot') as data FROM fc_objectsnapshots WHERE ` +
      `record->'objectSnapshot'->'metadata'->'uid' ? '${uid}' and ` +
      `record->'objectSnapshot'->'kind' ? 'Framework' ` +
      `ORDER BY cast(record->'objectSnapshot'->'status'->'attemptStatus'->>'id' as INTEGER) ASC;`;
    const [pgResult, metadata] = await sequelize.query(sqlSentence);
    const jobRetries = await Promise.all(
      pgResult.map((row) => {
        return convertToJobAttempt(row.data);
      }),
    );
    attemptData.push(
      ...jobRetries.map((jobRetry) => {
        return {...jobRetry, isLatest: false};
      }),
    );

    return {status: 200, data: attemptData}
  };

  const get = async (frameworkName, jobAttemptIndex) => {
    let uid;
    let attemptFramework;
    let response;
    try {
      response = await k8sModel.getClient().get(
        launcherConfig.frameworkPath(encodeName(frameworkName)),
        {
          headers: launcherConfig.requestHeaders,
        }
      );
    } catch (error) {
      logger.error(`error when getting framework from k8s api: ${error.message}`);
      if (error.response != null) {
        response = error.response;
      } else {
        throw error;
      }
    }

    if (response.status === 200) {
      // get uid from k8s framwork API
      uid = response.data.metadata.uid;
      attemptFramework = response.data;
    } else if (response.status === 404) {
      logger.warn(`could not get framework ${uid} from k8s: ${JSON.stringify(response)}`);
      return {status: 404, data: null};
    } else {
      throw createError(response.status, 'UnknownError', response.data.message);
    }

    if (jobAttemptIndex < attemptFramework.spec.retryPolicy.maxRetryCount) {
      if (isNil(uid)) {
        return {status: 404, data: null};
      }
      const sqlSentence = `SELECT (record->'objectSnapshot') as data FROM fc_objectsnapshots WHERE ` +
        `record->'objectSnapshot'->'metadata'->'uid' ? '${uid}' and ` +
        `record->'objectSnapshot'->'status'->'attemptStatus'->>'id' = '${jobAttemptIndex}' and ` +
        `record->'objectSnapshot'->'kind' ? 'Framework' ` +
        `ORDER BY cast(record->'objectSnapshot'->'status'->'attemptStatus'->>'id' as INTEGER) ASC;`;
      const [pgResult, metadata] = await sequelize.query(sqlSentence);

      if (pgResult.length === 0) {
        return {status: 404, data: null};
      } else {
        attemptFramework = pgResult[0].data;
        const attemptDetail = await convertToJobAttempt(attemptFramework);
        return {status: 200, data: {...attemptDetail, isLatest: false}};
      }
    } else if (
      jobAttemptIndex === attemptFramework.spec.retryPolicy.maxRetryCount
    ) {
      // get latest frameworks from k8s API
      const attemptDetail = await convertToJobAttempt(attemptFramework);
      return {status: 200, data: {...attemptDetail, isLatest: true}};
    } else {
      return {status: 404, data: null};
    }
  };

  module.exports = {
    healthCheck,
    list,
    get,
  };
} else {
  module.exports = {
    healthCheck: () => false,
    list: () => { throw Error('Unexpected Call') },
    get: () => { throw Error('Unexpected Call') },
  };
}
