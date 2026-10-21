const { run, endpoints } = require('./_adapter');
exports.handler = (event) => run(event, endpoints.stream);
