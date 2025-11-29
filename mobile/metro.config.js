const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const { resolver } = config;

resolver.assetExts = [...resolver.assetExts, 'txt', 'wasm'];
resolver.sourceExts = resolver.sourceExts.filter((ext) => ext !== 'txt' && ext !== 'wasm');

module.exports = config;
