'use strict';

const {
  SEGMENT_LABELS,
  STATUS,
  buildShipment,
  buildShipments,
  analyzeShipments,
  computeSegmentStats,
} = require('./src/segmenter');
const {
  generateShipments,
  generateLateAdditions,
  DEFAULT_SEED,
} = require('./src/fixtures');

module.exports = {
  SEGMENT_LABELS,
  STATUS,
  buildShipment,
  buildShipments,
  analyzeShipments,
  computeSegmentStats,
  generateShipments,
  generateLateAdditions,
  DEFAULT_SEED,
};
