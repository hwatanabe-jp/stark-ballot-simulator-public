/** Compare the observed revision, or require absence for a new record. */
export function matchItemRevision(current: { revision: number } | undefined) {
  return current
    ? {
        ConditionExpression: '#revision = :expectedRevision',
        ExpressionAttributeNames: { '#revision': 'revision' },
        ExpressionAttributeValues: { ':expectedRevision': current.revision },
      }
    : {
        ConditionExpression: 'attribute_not_exists(#sessionId)',
        ExpressionAttributeNames: { '#sessionId': 'sessionId' },
      };
}
