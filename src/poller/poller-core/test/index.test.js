/* Copyright 2020 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License
 */

/*
 * ESLINT: Ignore max line length errors on lines starting with 'it('
 * (test descriptions)
 */
/* eslint max-len: ["error", { "ignorePattern": "^\\s*it\\(" }] */

const rewire = require('rewire');
// eslint-disable-next-line no-unused-vars
const should = require('should');
const sinon = require('sinon');
const {ValidationError} = require('../config-validator');

const app = rewire('../index.js');

/**
 * @typedef {import('../../../autoscaler-common/types').AutoscalerSpanner
 * } AutoscalerSpanner
 * @typedef {import('../../../autoscaler-common/types').SpannerMetric
 * } SpannerMetric
 * @typedef {import('../../../autoscaler-common/types').SpannerMetricValue
 * } SpannerMetricValue
 */

const buildMetrics = app.__get__('buildMetrics');
/** @type {function(string): Promise<AutoscalerSpanner[]>} */
const parseAndEnrichPayload = app.__get__('parseAndEnrichPayload');
const validateCustomMetric = app.__get__('validateCustomMetric');
const getCloudRunJobScalingRequirement = app.__get__(
  'getCloudRunJobScalingRequirement',
);
const enrichScalingRequirements = app.__get__('enrichScalingRequirements');

describe('#buildMetrics', () => {
  it('should return 3 metrics', () => {
    buildMetrics('fakeProjectId', 'fakeInstanceId').should.have.length(3);
  });

  it('should insert the projectId', () => {
    buildMetrics('fakeProjectId', 'fakeInstanceId')[0].filter.should.have.match(
      /fakeProjectId/,
    );
  });

  it('should insert the instanceId', () => {
    buildMetrics('fakeProjectId', 'fakeInstanceId')[2].filter.should.have.match(
      /fakeInstanceId/,
    );
  });
});

describe('#validateCustomMetric', () => {
  it('should return false if name is missing', () => {
    validateCustomMetric({
      filter: 'my filter',
      regional_threshold: 10,
    }).should.be.false();
  });

  it('should return false if filter is blank', () => {
    validateCustomMetric({
      name: 'custom_filter',
      filter: '',
      regional_threshold: 10,
    }).should.be.false();
  });

  it('should return false if thresholds are missing', () => {
    validateCustomMetric({
      name: 'custom_filter',
      filter: 'my filter',
    }).should.be.false();
  });

  it('should return false if thresholds are less than equal to 0', () => {
    validateCustomMetric({
      name: 'custom_filter',
      filter: 'my filter',
      regional_threshold: 0,
    }).should.be.false();
  });

  it('should return true all fields are present and valid', () => {
    validateCustomMetric({
      name: 'custom_filter',
      filter: 'my filter',
      multi_regional_threshold: 50,
    }).should.be.true();
  });
});

describe('#parseAndEnrichPayload', () => {
  it('should return the default for stepSize', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        minSize: 10,
      },
    ]);

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    should(mergedConfig[0].stepSize).equal(2);

    unset();
  });

  it('should merge in defaults for processing units', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        units: 'PROCESSING_UNITS',
        minSize: 200,
      },
    ]);

    const stub = sinon.stub().resolves({currentSize: 500, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    should(mergedConfig[0].minSize).equal(200);
    should(mergedConfig[0].maxSize).equal(2000);
    should(mergedConfig[0].stepSize).equal(200);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'minNodes');
    idx.should.equal(-1);

    unset();
  });

  it('should use the value of minSize/maxSize for minNodes/maxNodes instead of overriding with the defaults, Github Issue 61', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        units: 'NODES',
        minSize: 20,
        maxSize: 50,
      },
    ]);

    const stub = sinon.stub().resolves({currentSize: 50, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    should(mergedConfig[0].minSize).equal(20);
    should(mergedConfig[0].maxSize).equal(50);

    unset();
  });

  it('should override the regional threshold for storage but not high_priority_cpu', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        minSize: 10,
        metrics: [
          {
            name: 'storage',
            regional_threshold: 10,
            multi_regional_threshold: 10,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);

    let idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'storage');

    let metric = /** @type {SpannerMetric} */ (mergedConfig[0].metrics[idx]);
    metric.regional_threshold.should.equal(10);
    metric.multi_regional_threshold.should.equal(10);
    idx = mergedConfig[0].metrics.findIndex(
      (x) => x.name === 'high_priority_cpu',
    );
    metric = /** @type {SpannerMetric} */ (mergedConfig[0].metrics[idx]);
    metric.regional_threshold.should.equal(65);

    unset();
  });

  it('should override the multiple thresholds', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        minSize: 10,
        metrics: [
          {
            name: 'high_priority_cpu',
            regional_threshold: 20,
            multi_regional_threshold: 20,
          },
          {
            name: 'storage',
            regional_threshold: 10,
            multi_regional_threshold: 10,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);

    let idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'storage');
    let metric = /** @type {SpannerMetric} */ (mergedConfig[0].metrics[idx]);
    metric.regional_threshold.should.equal(10);
    idx = mergedConfig[0].metrics.findIndex(
      (x) => x.name === 'high_priority_cpu',
    );
    metric = /** @type {SpannerMetric} */ (mergedConfig[0].metrics[idx]);
    metric.multi_regional_threshold.should.equal(20);

    unset();
  });

  it('should add a custom metric to the list if metric name is a default metric', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        minSize: 10,
        metrics: [
          {
            filter: 'my super cool filter',
            name: 'bogus',
            multi_regional_threshold: 20,
            regional_threshold: 20,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'bogus');
    const metric = /** @type {SpannerMetric} */ (mergedConfig[0].metrics[idx]);
    metric.multi_regional_threshold.should.equal(20);
    unset();
  });

  it('should not add a custom metric to the list if the provided metric is not valid', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        minSize: 10,
        metrics: [
          {
            name: 'bogus',
            regional_threshold: 10,
            multi_regional_threshold: 20,
          },
        ],
      },
    ]);

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'bogus');
    idx.should.equal(-1);
    unset();
  });

  it('should throw if the nodes are specified if units is set something other than nodes or processing units', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        units: 'BOGUS',
        minSize: 200,
      },
    ]);

    const stub = sinon.stub().resolves({currentSize: 500, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(
      new ValidationError(
        'Invalid Autoscaler Configuration parameters:\n' +
          'SpannerConfig/0/units must be equal to one of the allowed values',
      ),
    );

    unset();
  });

  it('should throw if the sizes are specified as strings', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
        units: 'NODES',
        minSize: '300',
      },
    ]);

    const stub = sinon.stub().resolves({currentSize: 500, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(
      new ValidationError(
        'Invalid Autoscaler Configuration parameters:\n' +
          'SpannerConfig/0/minSize must be number',
      ),
    );

    unset();
  });

  it('should throw if the config is not an array', async () => {
    const payload = JSON.stringify({
      projectId: 'my-spanner-project',
      instanceId: 'spanner1',
      scalerPubSubTopic: 'projects/my-project/topics/spanner-scaling',
      units: 'NODES',
      minSize: '300',
    });

    const stub = sinon.stub().resolves({currentSize: 500, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(
      new ValidationError(
        'Invalid Autoscaler Configuration parameters:\n' +
          'SpannerConfig must be array',
      ),
    );

    unset();
  });
});

describe('#getCloudRunJobScalingRequirement', () => {
  const NOW = Date.parse('2026-10-07T12:00:00Z');
  const JOBS = 'projects/{p}/locations/{r}/jobs';
  const clock = {restore: () => {}};
  const jobsList = sinon.stub();
  const executionsList = sinon.stub();
  /** @type {function(): void} */
  let unset = () => {};

  /**
   * @param {string} parent
   * @param {string[]} names
   * @return {any}
   */
  function jobsPage(parent, names) {
    return {data: {jobs: names.map((n) => ({name: `${parent}/jobs/${n}`}))}};
  }

  /**
   * @param {number} hoursAgo
   * @param {boolean} completed
   * @return {any}
   */
  function execution(hoursAgo, completed) {
    const createTime = new Date(NOW - hoursAgo * 3600 * 1000).toISOString();
    return completed ? {createTime, completionTime: createTime} : {createTime};
  }

  /**
   * @param {Object} [overrides]
   * @return {any[]}
   */
  function config(overrides) {
    return [
      {
        projectId: 'p',
        region: ['r'],
        jobs: ['conveyor-polyflow-node'],
        unitsPerExecution: 2000,
        lookbackHours: 24,
        ...overrides,
      },
    ];
  }

  beforeEach(() => {
    sinon.useFakeTimers({now: NOW, toFake: ['Date']});
    jobsList.reset();
    executionsList.reset();
    unset = app.__set__('cloudRunRestApi', {
      projects: {
        locations: {
          jobs: {list: jobsList, executions: {list: executionsList}},
        },
      },
    });
  });

  afterEach(() => {
    sinon.restore();
    clock.restore();
    unset();
  });

  it('adds units for every running execution of a matching job', async () => {
    const parent = JOBS.replace('/jobs', '')
      .replace('{p}', 'p')
      .replace('{r}', 'r');
    jobsList.resolves(
      jobsPage(parent, ['conveyor-polyflow-node', 'ingest-polyflow-node']),
    );
    executionsList.resolves({
      data: {
        executions: [
          execution(1, false),
          execution(2, true),
          execution(3, false),
        ],
      },
    });

    const size = await getCloudRunJobScalingRequirement(config(), 12000);

    should(size).equal(4000);
    sinon.assert.calledOnce(executionsList);
    sinon.assert.calledWithMatch(executionsList, {
      parent: `${parent}/jobs/conveyor-polyflow-node`,
    });
  });

  it('counts every job when no job prefix is configured', async () => {
    jobsList.resolves(jobsPage('projects/p/locations/r', ['a', 'b']));
    executionsList.resolves({data: {executions: [execution(1, false)]}});

    const size = await getCloudRunJobScalingRequirement(
      config({jobs: []}),
      12000,
    );

    should(size).equal(4000);
    sinon.assert.calledTwice(executionsList);
  });

  it('returns zero when nothing is running', async () => {
    jobsList.resolves(
      jobsPage('projects/p/locations/r', ['conveyor-polyflow-node']),
    );
    executionsList.resolves({data: {executions: [execution(1, true)]}});

    should(await getCloudRunJobScalingRequirement(config(), 12000)).equal(0);
  });

  it('caps the requirement at maxUnits', async () => {
    jobsList.resolves(
      jobsPage('projects/p/locations/r', ['conveyor-polyflow-node']),
    );
    executionsList.resolves({
      data: {executions: [execution(1, false), execution(1, false)]},
    });

    should(await getCloudRunJobScalingRequirement(config(), 3000)).equal(3000);
  });

  it('stops paging executions older than the lookback window', async () => {
    jobsList.resolves(
      jobsPage('projects/p/locations/r', ['conveyor-polyflow-node']),
    );
    executionsList
      .onFirstCall()
      .resolves({
        data: {
          executions: [execution(1, false), execution(30, true)],
          nextPageToken: 'more',
        },
      })
      .onSecondCall()
      .resolves({data: {executions: [execution(40, false)]}});

    should(await getCloudRunJobScalingRequirement(config(), 12000)).equal(2000);
    sinon.assert.calledOnce(executionsList);
  });

  it('follows execution pages inside the lookback window', async () => {
    jobsList.resolves(
      jobsPage('projects/p/locations/r', ['conveyor-polyflow-node']),
    );
    executionsList
      .onFirstCall()
      .resolves({
        data: {executions: [execution(1, true)], nextPageToken: 'more'},
      })
      .onSecondCall()
      .resolves({data: {executions: [execution(2, false)]}});

    should(await getCloudRunJobScalingRequirement(config(), 12000)).equal(2000);
    sinon.assert.calledTwice(executionsList);
    sinon.assert.calledWithMatch(executionsList.secondCall, {
      pageToken: 'more',
    });
  });

  it('inspects every configured project and region', async () => {
    jobsList.resolves(
      jobsPage('projects/x/locations/y', ['conveyor-polyflow-node']),
    );
    executionsList.resolves({data: {executions: [execution(1, false)]}});

    const size = await getCloudRunJobScalingRequirement(
      [
        {...config()[0], region: ['r1', 'r2']},
        {...config()[0], projectId: 'q', unitsPerExecution: 500},
      ],
      12000,
    );

    should(size).equal(4500);
    sinon.assert.calledWithMatch(jobsList, {parent: 'projects/p/locations/r1'});
    sinon.assert.calledWithMatch(jobsList, {parent: 'projects/p/locations/r2'});
    sinon.assert.calledWithMatch(jobsList, {parent: 'projects/q/locations/r'});
  });
});

describe('#enrichScalingRequirements', () => {
  afterEach(() => sinon.restore());

  it('resolves requiredSize for every requirement', async () => {
    const dataflow = sinon.stub().resolves(4000);
    const cloudrun = sinon.stub().resolves(2000);
    const unsetDataflow = app.__set__(
      'getDataflowJobScalingRequirement',
      dataflow,
    );
    const unsetCloudRun = app.__set__(
      'getCloudRunJobScalingRequirement',
      cloudrun,
    );
    const spanner = /** @type {any} */ ({
      projectId: 'p',
      instanceId: 'i',
      maxSize: 12000,
      requirements: [
        {service: 'dataflow', config: [{projectId: 'd', regions: ['r']}]},
        {
          service: 'cloudrun',
          config: [{projectId: 'c', regions: ['r'], unitsPerExecution: '0'}],
        },
      ],
    });

    await enrichScalingRequirements(spanner);

    should(spanner.requirements[0].requiredSize).equal(4000);
    should(spanner.requirements[1].requiredSize).equal(2000);
    should(dataflow.firstCall.args[0][0]).containEql({
      projectId: 'd',
      region: ['r'],
      multiplier: 1,
    });
    should(cloudrun.firstCall.args[0][0]).containEql({
      projectId: 'c',
      region: ['r'],
      jobs: [],
      unitsPerExecution: 0,
      lookbackHours: 24,
    });
    unsetDataflow();
    unsetCloudRun();
  });

  it('applies cloudrun defaults', async () => {
    const cloudrun = sinon.stub().resolves(0);
    const unset = app.__set__('getCloudRunJobScalingRequirement', cloudrun);
    const spanner = /** @type {any} */ ({
      maxSize: 12000,
      requirements: [
        {service: 'cloudrun', config: [{projectId: 'c', region: ['r']}]},
      ],
    });

    await enrichScalingRequirements(spanner);

    should(cloudrun.firstCall.args[0][0]).containEql({
      jobs: [],
      unitsPerExecution: 2000,
      lookbackHours: 24,
    });
    unset();
  });

  it('is a no-op without requirements', async () => {
    await enrichScalingRequirements(/** @type {any} */ ({maxSize: 100}));
  });
});
