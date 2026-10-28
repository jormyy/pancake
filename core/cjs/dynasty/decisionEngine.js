"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.valueDynastyAsset = exports.DYNASTY_STRATEGIES = exports.analyzeDynastyTrade = exports.DYNASTY_TRADE_MODEL_VERSION = void 0;
exports.valueDynastyAssets = valueDynastyAssets;
const tradeScoring_1 = require("./tradeScoring");
exports.DYNASTY_TRADE_MODEL_VERSION = tradeScoring_1.TRADE_FORMULA_VERSION;
exports.analyzeDynastyTrade = tradeScoring_1.analyzeDynastyTrade;
exports.DYNASTY_STRATEGIES = ['overall', 'contend', 'rebuild'];
exports.valueDynastyAsset = tradeScoring_1.valueDynastyAsset;
function valueDynastyAssets(context, assets) {
    return assets.map((asset) => (0, exports.valueDynastyAsset)(context, asset));
}
