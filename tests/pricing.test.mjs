import test from 'node:test';
import assert from 'node:assert/strict';
import {estimateCodexCost as cost} from '../src/pricing.mjs';
test('public reference pricing separates cached reads, writes and output',()=>{
 assert.equal(cost('gpt-6-astra',{inputTokens:1000,cachedInputTokens:200,cacheWriteInputTokens:100,outputTokens:100}),.01345);
 assert.equal(cost('gpt-6-astra',{inputTokens:0,outputTokens:0}),0);
 assert.equal(cost('gpt-6-astra',{inputTokens:300000,outputTokens:1000}),6.075);
});
test('unknown prices and invalid token breakdowns never fabricate a cost',()=>{
 for(const [model,usage] of [['custom', {inputTokens:10,outputTokens:1}],['gpt-6-astra',{inputTokens:10,outputTokens:1,cachedInputTokens:20}],['gpt-6-astra',{inputTokens:null,outputTokens:1}]])assert.equal(cost(model,usage),undefined);
});
