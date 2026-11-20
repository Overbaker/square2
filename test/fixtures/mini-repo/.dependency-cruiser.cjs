module.exports = {
  forbidden: [
    { name: 'no-vendor', severity: 'error', from: { path: '^apps/', pathNot: '/test/' }, to: { path: '^(pg|ws|jose|node:sqlite)$' } },
  ],
};
