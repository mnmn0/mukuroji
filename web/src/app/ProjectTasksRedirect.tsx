import { Navigate, useParams, useSearchParams } from 'react-router'

/**
 * 旧 project task URL を Issue 遂行ビューへリダイレクトする互換 component です。
 */
export function ProjectTasksRedirect() {
  const params = useParams()
  const [searchParams] = useSearchParams()
  const projectId = params.projectId ?? ''
  const query = searchParams.toString()

  return (
    <Navigate
      replace
      to={`/projects/${encodeURIComponent(projectId)}/issues${query ? `?${query}` : ''}`}
    />
  )
}
