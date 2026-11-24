/**
 * Decodes the predefined XML entities in a SAML metadata attribute value.
 *
 * `&amp;` is decoded last so that an escaped entity such as `&amp;lt;` becomes `&lt;`, not `<`.
 *
 * @param value - Raw attribute value read from the metadata document.
 * @returns The attribute value with the predefined entities decoded once.
 */
export function decodeEnterpriseXml(value: string) {
  return value
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', '\'')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}
