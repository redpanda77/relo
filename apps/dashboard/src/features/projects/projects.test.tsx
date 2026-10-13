import { cleanup,render,screen,within } from "@testing-library/react"
import { afterEach,describe,expect,it,vi } from "vitest"
import { ProjectsPage } from "@/features/projects/projects-page"
import {
  projectsDashboardBootstrapSchema,
  type ProjectsDashboardBootstrap,
} from "@/features/projects/types"
import { projectsService } from "@/services/projects-service"

const now = "2026-08-13T12:00:00.000Z"
const project = {
  id:"prj_11111111-1111-4111-8111-111111111111",
  key:"named:relo",
  name:"Relo",
  displayNameSource:"owner" as const,
  isDirect:false,
  provenance:"explicit",
  palette:{ slot:3,generation:1 },
  icon:"folder",
  revision:4,
  archivedAt:null,
  firstSeenAt:now,
  lastSeenAt:now,
  counts:{ conversations:1,notifications:7,activities:2 },
}
const bootstrap: ProjectsDashboardBootstrap = {
  version:1,
  kind:"projects",
  route:{ path:"/dashboard/projects",selectedProjectId:null },
  shell:{
    title:"Projects",
    description:"Stable identity and lifecycle controls.",
    active:"projects",
    releaseIdentity:"0.7.13-test",
    account:{ id:"acc_public",initial:"K",name:"Relo Owner",email:"owner@example.test" },
    counts:{ pending:0,notifications:7,deliveries:7 },
  },
  summary:{ active:1,direct:0,archived:0,conversations:1 },
  projects:[project],
  selected:null,
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe("Projects workspace",() => {
  it("validates the resource registry bootstrap without accepting unknown secrets",() => {
    const hostile = { ...bootstrap,credential:"must-not-cross" }
    const parsed = projectsDashboardBootstrapSchema.parse(hostile)
    expect(parsed).not.toHaveProperty("credential")
    expect(() => projectsDashboardBootstrapSchema.parse({
      ...bootstrap,
      projects:[{ ...project,palette:{ slot:-1,generation:0 } }],
    })).toThrow()
  })

  it("renders a compact project index with operational counts",() => {
    render(<ProjectsPage bootstrap={bootstrap} />)
    expect(screen.getByRole("heading",{ name:"Projects" })).toBeInTheDocument()
    const link = screen.getByRole("link",{ name:/Relo/ })
    expect(link).toHaveAttribute("href",`/dashboard/projects/${project.id}`)
    expect(link).toHaveTextContent("1 topic · 7 notifications")
  })

  it("exposes immutable identity, exact split mechanics, and guarded lifecycle actions",() => {
    const detail: ProjectsDashboardBootstrap = {
      ...bootstrap,
      projects:[project,{
        ...project,
        id:"prj_44444444-4444-4444-8444-444444444444",
        key:"named:destination",
        name:"Destination",
        revision:2,
        palette:{ slot:5,generation:0 },
      }],
      route:{ path:`/dashboard/projects/${project.id}`,selectedProjectId:project.id },
      selected:{
        project,
        aliases:[{ id:"als_22222222-2222-4222-8222-222222222222",name:"Relo notifications",provenance:"owner",createdAt:now }],
        conversations:[{ id:"cnv_33333333-3333-4333-8333-333333333333",name:"D03 execution",producerKind:"agent",assignmentSource:"owner",lastSeenAt:now }],
        recent:[{ id:"event",kind:"notification",title:"Lifecycle ready",state:"recorded",occurredAt:now }],
      },
    }
    render(<ProjectsPage bootstrap={detail} />)
    expect(screen.getByText("Relo notifications")).toBeInTheDocument()
    const splitHeading = screen.getByText("Split conversations")
    const splitCard = splitHeading.closest<HTMLElement>("[data-slot='card']")!
    expect(within(splitCard).getByRole("checkbox",{ name:"D03 execution" })).toBeInTheDocument()
    expect(within(splitCard).getByRole("group",{ name:"Conversations to move" })).toBeInTheDocument()
    expect(within(splitCard).getByRole("button",{ name:"Select conversations and destination" })).toBeDisabled()
    expect(within(screen.getByText("Merge project").closest<HTMLElement>("[data-slot='card']")!).getByRole("button",{ name:"Choose a merge destination" })).toBeDisabled()
    expect(screen.getByRole("button",{ name:"Archive project" })).toBeInTheDocument()
  })

  it("posts revision-fenced owner changes to the lifecycle API",async () => {
    const fetchMock = vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response(JSON.stringify({ ok:true,projectId:project.id,revision:5 }),{ status:200,headers:{ "content-type":"application/json" } }))
    await projectsService.update(project.id,{ expectedRevision:4,displayName:"Relo Core",paletteSlot:3,icon:"code" })
    expect(fetchMock).toHaveBeenCalledWith(`/api/dashboard/resources/projects/${project.id}`,{
      method:"PATCH",
      headers:{ "content-type":"application/json" },
      body:JSON.stringify({ expectedRevision:4,displayName:"Relo Core",paletteSlot:3,icon:"code" }),
    })
  })
})
