/**
 * DynamoDB Streams event に含まれる AttributeValue の最小表現です。
 */
export type DynamoAttributeValue = {
  /** 文字列値です。 */
  S?: string
  /** 数値を表す文字列値です。 */
  N?: string
  /** 真偽値です。 */
  BOOL?: boolean
  /** null marker です。 */
  NULL?: boolean
  /** list value です。 */
  L?: DynamoAttributeValue[]
  /** map value です。 */
  M?: Record<string, DynamoAttributeValue>
  /** string set です。 */
  SS?: string[]
  /** number set です。 */
  NS?: string[]
}

/**
 * DynamoDB Streams record の database image です。
 */
export type DynamoStreamImage = {
  /** mutation 後の DynamoDB item です。 */
  NewImage?: Record<string, DynamoAttributeValue>
  /** Lambda partial batch response で checkpoint に使う stream sequence number です。 */
  SequenceNumber?: string
}

/**
 * DynamoDB Streams の1 record です。
 */
export type DynamoStreamRecord = {
  /** 診断用の DynamoDB Streams event ID です。 */
  eventID?: string
  /** INSERT、MODIFY、REMOVE の event 種別です。 */
  eventName?: string
  /** AWS Lambda event source の canonical service identifier です。 */
  eventSource?: string
  /** DynamoDB item image です。 */
  dynamodb?: DynamoStreamImage
}

/**
 * DynamoDB Streams Lambda event です。
 */
export type DynamoStreamEvent = {
  /** 同じ batch で配送された stream records です。 */
  Records?: DynamoStreamRecord[]
}

/**
 * 再試行する stream record の識別子です。
 */
export type BatchItemFailure = {
  /** 再試行対象の DynamoDB Streams sequence number です。 */
  itemIdentifier: string
}

/**
 * Lambda partial batch failure response です。
 */
export type BatchResponse = {
  /** 処理に失敗した stream records です。 */
  batchItemFailures: BatchItemFailure[]
}
