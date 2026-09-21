// Shared helpers for the Vercel serverless functions in api/ — the underscore
// prefix keeps Vercel from routing this file as an endpoint itself.
// Mirrors the json()/readBody() helpers in vite.config.js so the dev-server
// middlewares and the deployed functions stay shape-identical.

export const json = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
};

export const readBody = (req) =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data || '{}'));
      } catch {
        resolve({});
      }
    });
  });
