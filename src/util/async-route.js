// Express 4 does not automatically forward rejected async route promises.
export const asyncRoute = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
