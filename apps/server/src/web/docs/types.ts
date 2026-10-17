/** The built docs site (apps/server/docs-build/build-docs.mjs): navigation and pages, rendered at build time. */
export type DocsLink = { path: string; title: string };

export type DocsSection = {
  title: string;
  path: string | null;
  pages: DocsLink[];
  groups: Array<{ title: string; pages: DocsLink[] }>;
};

export type DocsPage = {
  path: string;
  title: string;
  /** The short title the sidebar shows. */
  nav: string;
  summary: string;
  section: string;
  group: string | null;
  html: string;
  markdown: string;
  outline: Array<{ id: string; text: string; level: number }>;
  search: Array<{ anchor: string | null; title: string; text: string }>;
  editUrl: string;
  prev: DocsLink | null;
  next: DocsLink | null;
  breadcrumbs: Array<{ path: string | null; title: string }>;
};

export type DocsSite = {
  version: 1;
  /** The CLI version the reference was generated from. */
  cli: string;
  sections: DocsSection[];
  pages: DocsPage[];
};
