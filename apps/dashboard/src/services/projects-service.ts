export type ProjectMutationResult = { ok: true; projectId: string; revision: number }

async function request<Result>(path: string,method: string,input: unknown): Promise<Result> {
  const response = await fetch(path,{
    method,
    headers:{ "content-type":"application/json" },
    body:JSON.stringify(input),
  })
  const payload = await response.json().catch(() => null) as { error?: string; message?: string } | Result | null
  if (!response.ok) {
    const message = payload && typeof payload === "object" && "message" in payload
      ? payload.message
      : payload && typeof payload === "object" && "error" in payload
        ? payload.error
        : `Request failed (${response.status}).`
    throw new Error(message || "Project change failed.")
  }
  return payload as Result
}

export const projectsService = {
  update(projectId:string,input:{ expectedRevision:number;displayName?:string;icon?:string;paletteSlot?:number }) {
    return request<ProjectMutationResult>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}`,"PATCH",input)
  },
  addAlias(projectId:string,input:{ expectedRevision:number;displayName:string }) {
    return request<ProjectMutationResult & { aliasId:string }>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}/aliases`,"POST",input)
  },
  removeAlias(projectId:string,aliasId:string,expectedRevision:number) {
    return request<ProjectMutationResult>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}/aliases/${encodeURIComponent(aliasId)}`,"DELETE",{ expectedRevision })
  },
  merge(projectId:string,input:{ expectedRevision:number;targetProjectId:string;targetExpectedRevision:number }) {
    return request<ProjectMutationResult>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}/merge`,"POST",input)
  },
  split(projectId:string,input:{
    expectedRevision:number
    conversationIds:string[]
    destination:{ kind:"existing";projectId:string;expectedRevision:number } | { kind:"new";displayName:string }
  }) {
    return request<ProjectMutationResult & { moved:number }>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}/split`,"POST",input)
  },
  archive(projectId:string,expectedRevision:number) {
    return request<ProjectMutationResult>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}`,"DELETE",{ expectedRevision })
  },
  restore(projectId:string,expectedRevision:number) {
    return request<ProjectMutationResult>(`/api/dashboard/resources/projects/${encodeURIComponent(projectId)}/restore`,"POST",{ expectedRevision })
  },
}
