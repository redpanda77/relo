import {
  BellRing,
  BookOpen,
  Cable,
  FlaskConical,
  Inbox,
  FolderKanban,
  UserRound,
} from "lucide-react"
import * as React from "react"

import type { AuthenticatedDashboardBootstrap } from "@/app/bootstrap"
import { AccountFooter } from "@/components/molecules/account-footer"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar"
const navigation = [
  {
    label: "Operate",
    items: [
      {
        label: "Inbox",
        href: "/dashboard",
        icon: Inbox,
        sections: ["inbox", "inbox-notifications", "inbox-delivery"],
      },
      {
        label: "Projects",
        href: "/dashboard/projects",
        icon: FolderKanban,
        sections: ["projects"],
      },
      {
        label: "Connections",
        href: "/dashboard/connections/services",
        icon: Cable,
        sections: [
          "connections-pairing",
          "connections-services",
          "connections-phones",
          "connections-clients",
        ],
      },
      {
        label: "Test Lab",
        href: "/dashboard/testing",
        icon: FlaskConical,
        sections: ["testing"],
      },
    ],
  },
  {
    label: "System",
    items: [
      {
        label: "Account",
        href: "/dashboard/account",
        icon: UserRound,
        sections: ["account"],
      },
      {
        label: "Documentation",
        href: "/dashboard/docs",
        icon: BookOpen,
        sections: ["docs"],
      },
    ],
  },
]

function MobileSidebarTrigger() {
  const { openMobile } = useSidebar()
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const wasOpen = React.useRef(false)

  React.useEffect(() => {
    if (wasOpen.current && !openMobile) triggerRef.current?.focus()
    wasOpen.current = openMobile
  }, [openMobile])

  return (
    <SidebarTrigger
      ref={triggerRef}
      id="mobile-nav-toggle"
      aria-controls="dashboard-sidebar"
      aria-expanded={openMobile}
      aria-label={openMobile ? "Close menu" : "Open menu"}
      className="size-11 md:hidden"
    />
  )
}

export function DashboardShell({
  shell,
  children,
}: {
  shell: AuthenticatedDashboardBootstrap["shell"]
  children: React.ReactNode
}) {
  return (
    <SidebarProvider>
      <a
        className="fixed top-3 left-3 z-[100] -translate-y-20 rounded-lg bg-primary px-4 py-3 text-sm text-primary-foreground focus:translate-y-0"
        href="#main-content"
      >
        Skip to content
      </a>
      <Sidebar collapsible="offcanvas" aria-label="Dashboard navigation">
        <aside
          id="dashboard-sidebar"
          className="flex h-full min-w-0 flex-col"
          aria-label="Dashboard navigation"
        >
          <SidebarHeader className="h-[72px] flex-row items-center gap-3 px-5 py-0">
            <span className="grid size-9 shrink-0 place-items-center rounded-[10px] bg-[#ff6b5e] text-[#1b0d0d]">
              <BellRing className="size-5" aria-hidden="true" />
            </span>
            <span className="font-semibold tracking-[-0.02em] text-foreground">
              Relo
            </span>
            <SidebarTrigger
              className="ml-auto size-11 md:hidden"
              aria-label="Close menu"
            />
          </SidebarHeader>

          <SidebarContent>
            <nav aria-label="Primary">
              {navigation.map((group) => (
                <SidebarGroup key={group.label} className="px-3 py-2">
                  <SidebarGroupLabel className="px-3 text-[11px] font-semibold tracking-[0.16em] uppercase">
                    {group.label}
                  </SidebarGroupLabel>
                  <SidebarGroupContent>
                    <SidebarMenu>
                      {group.items.map((item) => {
                        const Icon = item.icon
                        const active = item.sections.includes(shell.active)
                        return (
                          <SidebarMenuItem key={item.href}>
                            <SidebarMenuButton
                              asChild
                              isActive={active}
                              className="min-h-11 gap-3 rounded-[10px] px-3 text-muted-foreground data-active:text-foreground"
                            >
                              <a
                                href={item.href}
                                aria-current={active ? "page" : undefined}
                              >
                                <Icon aria-hidden="true" />
                                <span>{item.label}</span>
                              </a>
                            </SidebarMenuButton>
                          </SidebarMenuItem>
                        )
                      })}
                    </SidebarMenu>
                  </SidebarGroupContent>
                </SidebarGroup>
              ))}
            </nav>
          </SidebarContent>

          <SidebarFooter className="gap-0 p-0">
            <div
              className="border-t border-border px-4 py-3 text-xs text-muted-foreground"
              data-release-identity={shell.releaseIdentity}
            >
              <span className="block tracking-[0.12em] uppercase">Release</span>
              <strong className="mt-1 block truncate font-mono font-normal text-foreground">
                {shell.releaseIdentity}
              </strong>
            </div>
            <AccountFooter account={shell.account} />
          </SidebarFooter>
        </aside>
      </Sidebar>

      <div data-dashboard-main className="max-w-full min-w-0 flex-1">
        <header
          data-mobile-shell-header
          className="flex h-16 items-center gap-3 border-b border-border bg-background/95 px-4 md:hidden"
        >
          <MobileSidebarTrigger />
          <span className="min-w-0 truncate font-semibold">{shell.title}</span>
        </header>
        {children}
      </div>
    </SidebarProvider>
  )
}
