import useSWR from 'swr'

/**
 * Enterprise security snapshot を取得します。
 *
 * @param accessToken - Enterprise security API の access token です。
 * @param loader - Capability境界を適用したsnapshot loaderです。
 * @returns Enterprise security snapshot の SWR state と共有keyです。
 */
export function useEnterpriseSecurity<TResult>(
  accessToken: string,
  loader: (accessToken: string) => Promise<TResult>,
) {
  const key = ['enterprise-security', accessToken] as const
  const query = useSWR(
    key,
    ([, token]) => loader(token),
    {
      dedupingInterval: 10_000,
      shouldRetryOnError: false,
    },
  )

  return {
    ...query,
    key,
  }
}
