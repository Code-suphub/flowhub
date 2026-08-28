function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function stripWebCatalogMirror(config) {
  const persisted = cloneJson(config);
  const settings = persisted.plugins?.web?.settings;
  if (!settings) return persisted;
  settings.items = [];
  settings.catalogStorage = "sqlite";
  delete settings.catalogCount;
  delete settings.catalogSignature;
  return persisted;
}

module.exports = { stripWebCatalogMirror };
