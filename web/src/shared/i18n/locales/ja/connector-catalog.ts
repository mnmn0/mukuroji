/** Japanese copy for the connector catalog that lists only the providers configured in this environment. */
export const connectorCatalogMessages = {
  'connectors.catalog.emptyTitle': '利用できる connector はありません',
  'connectors.catalog.emptyDescription': 'この環境で設定済みの provider だけを表示します。運用者が provider を設定すると、ここから接続できます。',
  'connectors.catalog.availabilityLoading': 'この環境で使える connector を確認しています',
  'connectors.catalog.availabilityError': 'この環境で使える connector を確認できませんでした。確認できるまで、新しい接続は表示しません。',
  'connectors.catalog.notConfigured': 'この provider はこの環境で設定されていないため、新しい account は接続できません。',
} as const
