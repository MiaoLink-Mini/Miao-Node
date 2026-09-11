// USD per million tokens, standard API reference rates verified 2026-09-09.
// Source: https://developers.openai.com/api/docs/pricing
// Reference estimate: excludes tool charges, regional uplift and service-tier discounts.
const rates={
  'gpt-6-astra':[10,1,12.5,50],
  'gpt-5.6-sol':[4,.4,5,20],
  'gpt-5.6-terra':[2,.2,2.5,12],
  'gpt-5.6-luna':[.2,.02,.25,1.2],
  'gpt-5.5':[5,.5,null,30],
  'gpt-5.4':[2.5,.25,null,15]
};
export function estimateCodexCost(model,usage) {
  const rate=typeof model==='string'&&rates[model.toLowerCase()];if(!rate)return undefined;
  const input=usage.inputTokens,output=usage.outputTokens,cached=usage.cachedInputTokens??0,written=usage.cacheWriteInputTokens??0;
  if(![input,output,cached,written].every(n=>Number.isSafeInteger(n)&&n>=0)||cached+written>input)return undefined;
  if(written && rate[2]===null)return undefined;
  const long=input>272000;
  // Cached reads/writes are subsets of input; reasoning is already included in output.
  return ((input-cached-written)*rate[0]+cached*rate[1]+written*(rate[2]??0))*(long?2:1)/1e6+output*rate[3]*(long?1.5:1)/1e6;
}
