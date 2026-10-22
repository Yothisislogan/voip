export const EXPERIENCE_RUBRIC = 'wit-customer-experience-v1';
export const experienceSchema = {
  type: 'object', additionalProperties: false,
  properties: {
    csat: { type: ['integer','null'], minimum: 1, maximum: 5 },
    recommendation: { type: ['integer','null'], minimum: 0, maximum: 10 },
    confidence: { type: 'string', enum: ['low','medium','high'] },
    reason: { type: 'string' },
    evidence: { type: 'array', maxItems: 4, items: { type: 'string' } },
  },
  required: ['csat','recommendation','confidence','reason','evidence'],
};
export function validExperience(value) {
  const score = (n, min, max) => n === null || (Number.isInteger(n) && n >= min && n <= max);
  return !!value && score(value.csat, 1, 5) && score(value.recommendation, 0, 10)
    && ['low','medium','high'].includes(value.confidence)
    && typeof value.reason === 'string' && value.reason.trim().length > 0 && value.reason.length <= 2000
    && Array.isArray(value.evidence) && value.evidence.length <= 4
    && value.evidence.every(q => typeof q === 'string' && q.trim().length >= 4 && q.length <= 500);
}
export function recommendationBand(score) {
  if (!Number.isInteger(score) || score < 0 || score > 10) return null;
  return score >= 9 ? 'promoter' : score >= 7 ? 'passive' : 'detractor';
}
