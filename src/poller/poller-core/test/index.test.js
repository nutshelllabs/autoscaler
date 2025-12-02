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

const rewire = require('rewire');
const sinon = require('sinon');
// eslint-disable-next-line no-unused-vars
const should = require('should');
const {ValidationError} = require('../config-validator');

const app = rewire('../index.js');

const buildMetrics = app.__get__('buildMetrics');
const parseAndEnrichPayload = app.__get__('parseAndEnrichPayload');
const validateCustomMetric = app.__get__('validateCustomMetric');

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
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    mergedConfig[0].stepSize.should.equal(2);

    unset();
  });

  it('should override the default for minSize', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    mergedConfig[0].units.should.equal('NODES');
    mergedConfig[0].minSize.should.equal(10);

    unset();
  });

  it('should merge in defaults for processing units', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "units": "PROCESSING_UNITS", "minSize": 200}]';

    const stub = sinon.stub().resolves({currentSize: 500, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    mergedConfig[0].minSize.should.equal(200);
    mergedConfig[0].maxSize.should.equal(2000);
    mergedConfig[0].stepSize.should.equal(200);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'minNodes');
    idx.should.equal(-1);

    unset();
  });

  it('should use the value of minSize/maxSize for minNodes/maxNodes instead of overriding with the defaults, Github Issue 61', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "units": "NODES", "minSize": 20, "maxSize": 50}]';

    const stub = sinon.stub().resolves({currentSize: 50, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    mergedConfig[0].minSize.should.equal(20);
    mergedConfig[0].maxSize.should.equal(50);

    unset();
  });

  it('should override the regional threshold for storage but not high_priority_cpu', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10, "metrics": [{"name": "storage", "regional_threshold":10}]}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);

    let idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'storage');
    mergedConfig[0].metrics[idx].regional_threshold.should.equal(10);
    idx = mergedConfig[0].metrics.findIndex(
      (x) => x.name === 'high_priority_cpu',
    );
    mergedConfig[0].metrics[idx].regional_threshold.should.equal(65);

    unset();
  });

  it('should override the multiple thresholds', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10, "metrics": [{"name": "high_priority_cpu", "multi_regional_threshold":20}, {"name": "storage", "regional_threshold":10}]}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);

    let idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'storage');
    mergedConfig[0].metrics[idx].regional_threshold.should.equal(10);
    idx = mergedConfig[0].metrics.findIndex(
      (x) => x.name === 'high_priority_cpu',
    );
    mergedConfig[0].metrics[idx].multi_regional_threshold.should.equal(20);

    unset();
  });

  it('should add a custom metric to the list if metric name is a default metric', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10, "metrics": [{"filter": "my super cool filter", "name": "bogus", "multi_regional_threshold":20}]}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'bogus');
    mergedConfig[0].metrics[idx].multi_regional_threshold.should.equal(20);
    unset();
  });

  it('should not add a custom metric to the list if the provided metric is not valid', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10, "metrics": [{"filter": "my super cool filter", "name": "bogus"}]}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const idx = mergedConfig[0].metrics.findIndex((x) => x.name === 'bogus');
    idx.should.equal(-1);
    unset();
  });

  it('should throw if the nodes are specified if units is set something other than nodes or processing units', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "units": "BOGUS", "minSize": 200}]';

    const stub = sinon.stub().resolves({currentSize: 500, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    await parseAndEnrichPayload(payload).should.be.rejectedWith(Error, {
      message:
        /SpannerConfig.*units must be equal to one of the allowed values/,
    });

    unset();
  });

  it('should add dataflow requirement if dataflow is present in the config', async () => {
    const payload =
      '[{"projectId": "my-spanner-project", "instanceId": "spanner1", "scalerPubSubTopic": "projects/my-spanner-project/topics/spanner-scaling", "minSize": 10, "metrics": [{"filter": "my super cool filter", "name": "bogus", "multi_regional_threshold":20}], "requirements": [{"service": "dataflow", "config": [{"multiplier": "10", "projectId": "prj-foo","regions": ["us-central1", "us-west2"]}]}]}]';

    const stub = sinon.stub().resolves({currentNode: 5, regional: true});
    const unset = app.__set__('getSpannerMetadata', stub);

    const stub2 = sinon.stub().resolves(7500);
    const unset2 = app.__set__('getDataflowJobScalingRequirement', stub2);

    const mergedConfig = await parseAndEnrichPayload(payload);
    const requiredSize = mergedConfig[0].requirements[0].requiredSize;
    requiredSize.should.equal(7500);
    unset();
    unset2();
  });

  it('should throw if the sizes are specified as strings', async () => {
    const payload = JSON.stringify([
      {
        projectId: 'my-spanner-project',
        instanceId: 'spanner1',
        scalerPubSubTopic: 'projects/my-spanner-project/topics/spanner-scaling',
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
      scalerPubSubTopic: 'projects/my-spanner-project/topics/spanner-scaling',
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
