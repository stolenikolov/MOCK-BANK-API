// The whole bank as one Vercel function: vercel.json routes every path here.
module.exports = require('../dist/serverless').default;
