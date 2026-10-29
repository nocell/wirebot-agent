/**
 * The Skills tab: a searchable list, and a skill's SKILL.md instructions with
 * its bundled files. Phones use Instructions/Files tabs; desktop shows the
 * instructions beside an expandable file tree.
 */
import { ChevronRight, File, FileText, Folder } from "lucide-react";
import { type ReactElement, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { SkillDirectory, SkillDirectoryEntry, SkillFile } from "../agent/skill-browser.js";
import { type AvailableSkill, requestSkillResource } from "./api.js";
import { cn } from "./cn.js";
import { useAppData } from "./data.js";
import { Sheet } from "./dialogs.js";
import {
  ContentHeader,
  ListColHeader,
  PageTitle,
  Screen,
  ScreenBody,
  SplitView,
  SubpageHeader,
  TabBar,
  useDesktop,
} from "./layout.js";
import { navigate, type Route, routeLink, useRoute } from "./route.js";
import { type AsyncState, messageOf, useAsync } from "./shared.js";
import { useTelegramBackButton } from "./telegram.js";
import {
  Banner,
  Group,
  Hint,
  LoadingState,
  Placeholder,
  RowButton,
  RowLink,
  SearchField,
  Segmented,
  Spinner,
} from "./ui.js";

const skillsRoute: Route = { tab: "skills" };

export function SkillsTab(): ReactElement {
  const route = useRoute();
  const desktop = useDesktop();
  const data = useAppData();
  const [query, setQuery] = useState("");
  const skills = data.skills;
  const selectedName = route.detail;
  if (skills === undefined) {
    const loading = (
      <LoadingState
        header={data.skillsError === undefined ? "Loading skills" : "Couldn’t load skills"}
        description="Reading the skills currently available to this workspace…"
        error={data.skillsError}
        onRetry={data.reloadSkills}
      />
    );
    if (desktop) return loading;
    return (
      <Screen>
        {loading}
        <TabBar route={route} />
      </Screen>
    );
  }
  const filtered = filterSkills(skills, query);
  const selected =
    selectedName === undefined ? undefined : skills.find((skill) => skill.name === selectedName);
  if (desktop) {
    const active = selected ?? (selectedName === undefined ? skills[0] : undefined);
    return (
      <SplitView
        list={
          <>
            <ListColHeader>
              <SearchField
                placeholder="Search skills"
                aria-label="Search skills"
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </ListColHeader>
            <div className="listCol-body">
              {skills.length === 0 ? (
                <Hint>
                  No skills are installed yet. Add one under skills/ in the agent config directory.
                </Hint>
              ) : filtered.length === 0 ? (
                <Hint>No skills match “{query}”.</Hint>
              ) : (
                filtered.map((skill) => (
                  <a
                    key={skill.name}
                    className={cn("skillItem", active?.name === skill.name && "skillItem-selected")}
                    aria-current={active?.name === skill.name ? "page" : undefined}
                    {...routeLink({ tab: "skills", detail: skill.name })}
                  >
                    <span className="skillItem-name">{skill.name}</span>
                    <span className="skillItem-desc">{skill.description}</span>
                  </a>
                ))
              )}
            </div>
          </>
        }
      >
        {active !== undefined ? (
          <SkillDetailDesktop key={active.name} skill={active} />
        ) : selectedName !== undefined ? (
          <SkillMissing name={selectedName} />
        ) : (
          <div className="paneBody">
            <Placeholder
              header="No skills available"
              description="New skills apply from the next message."
            />
          </div>
        )}
      </SplitView>
    );
  }
  if (selectedName !== undefined) {
    return selected === undefined ? (
      <Screen className="screen-subpage">
        <SubpageHeader back={{ label: "Skills", route: skillsRoute }} title={selectedName} />
        <SkillMissing name={selectedName} />
      </Screen>
    ) : (
      <SkillDetailMobile key={selected.name} skill={selected} />
    );
  }
  return (
    <Screen>
      <PageTitle title="Skills" subtitle={`${skills.length} available to the agent`} />
      <ScreenBody className="stack-sm">
        <SearchField
          placeholder="Search skills"
          aria-label="Search skills"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        {skills.length === 0 ? (
          <Placeholder
            header="No skills available"
            description="New skills apply from the next message."
          />
        ) : filtered.length === 0 ? (
          <Hint>No skills match “{query}”.</Hint>
        ) : (
          <Group>
            {filtered.map((skill) => (
              <RowLink
                key={skill.name}
                label={skill.name}
                detail={skill.description}
                chevron
                {...routeLink({ tab: "skills", detail: skill.name })}
              />
            ))}
          </Group>
        )}
        <Hint>New skills apply from the next message.</Hint>
      </ScreenBody>
      <TabBar route={route} />
    </Screen>
  );
}

function SkillMissing({ name }: { readonly name: string }): ReactElement {
  return (
    <div className="paneBody">
      <Placeholder header="Skill not found" description={`“${name}” is not installed right now.`} />
    </div>
  );
}

function filterSkills(skills: readonly AvailableSkill[], query: string): readonly AvailableSkill[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return skills;
  return skills.filter(
    (skill) =>
      skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle),
  );
}

type DirectoryCache = ReadonlyMap<string, AsyncState<SkillDirectory>>;

/** Lazily loaded directory listings for one skill, keyed by path. */
function useDirectoryCache(skill: string): {
  readonly directories: DirectoryCache;
  readonly load: (path: string) => void;
} {
  const [directories, setDirectories] = useState<DirectoryCache>(new Map());
  const skillRef = useRef(skill);
  skillRef.current = skill;
  const load = useCallback(
    (path: string): void => {
      setDirectories((current) => (current.has(path) ? current : new Map(current).set(path, {})));
      void requestSkillResource(skill, path)
        .then((resource) => {
          if (resource.type !== "directory") throw new Error("This path is not a directory.");
          if (skillRef.current !== skill) return;
          setDirectories((current) => new Map(current).set(path, { value: resource }));
        })
        .catch((error: unknown) => {
          if (skillRef.current !== skill) return;
          setDirectories((current) => new Map(current).set(path, { error: messageOf(error) }));
        });
    },
    [skill],
  );
  useEffect(() => load(""), [load]);
  return { directories, load };
}

function useSkillDocument(skill: string): AsyncState<SkillFile> {
  return useAsync(async (): Promise<SkillFile> => {
    const resource = await requestSkillResource(skill, "SKILL.md");
    if (resource.type !== "file" || resource.encoding !== "utf8") {
      throw new Error("SKILL.md is not a readable text file.");
    }
    return resource;
  }, [skill]);
}

function useSkillFile(skill: string, path: string | undefined): AsyncState<SkillFile> {
  return useAsync(
    path === undefined
      ? undefined
      : async (): Promise<SkillFile> => {
          const resource = await requestSkillResource(skill, path);
          if (resource.type !== "file") throw new Error("This path is not a file.");
          return resource;
        },
    [skill, path],
  );
}

function SkillDetailMobile({ skill }: { readonly skill: AvailableSkill }): ReactElement {
  const [tab, setTab] = useState<"instructions" | "files">("instructions");
  const [directoryPath, setDirectoryPath] = useState("");
  const [previewPath, setPreviewPath] = useState<string>();
  const document = useSkillDocument(skill.name);
  const { directories, load } = useDirectoryCache(skill.name);
  const preview = useSkillFile(skill.name, previewPath);
  const root = directories.get("");
  const listing = directories.get(directoryPath);
  useEffect(() => {
    if (!directories.has(directoryPath)) load(directoryPath);
  }, [directories, directoryPath, load]);
  useTelegramBackButton(
    previewPath !== undefined
      ? undefined
      : () => {
          if (directoryPath.length > 0) setDirectoryPath(parentDirectory(directoryPath));
          else navigate(skillsRoute);
        },
  );
  const count = root?.value?.entries.length;
  const crumbParts = directoryPath.split("/").filter((part) => part.length > 0);
  return (
    <Screen className="screen-subpage">
      <SubpageHeader back={{ label: "Skills", route: skillsRoute }} title={skill.name} />
      <div className="skillIntro">
        <p className="skillIntro-description">{skill.description}</p>
        <Segmented
          aria-label="Skill content"
          options={[
            { value: "instructions", label: "Instructions" },
            { value: "files", label: count === undefined ? "Files" : `Files · ${count}` },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      <ScreenBody className={tab === "instructions" ? "skillBody" : "stack-sm"}>
        {tab === "instructions" ? (
          <>
            <Instructions document={document} />
            <Hint className="skillFootnote">
              These are the instructions Claude reads when it uses the skill.
            </Hint>
          </>
        ) : (
          <>
            <div className="crumbsSmall">
              {directoryPath.length === 0 ? (
                <span className="crumbsSmall-current">{skill.name}</span>
              ) : (
                <button type="button" className="linkButton" onClick={() => setDirectoryPath("")}>
                  {skill.name}
                </button>
              )}
              {crumbParts.map((part, index) => {
                const path = crumbParts.slice(0, index + 1).join("/");
                const last = index === crumbParts.length - 1;
                return (
                  <span key={path} className="crumbsSmall-part">
                    <ChevronRight aria-hidden="true" />
                    {last ? (
                      <span className="crumbsSmall-current">{part}</span>
                    ) : (
                      <button
                        type="button"
                        className="linkButton"
                        onClick={() => setDirectoryPath(path)}
                      >
                        {part}
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
            <DirectoryList
              listing={listing}
              onDirectory={setDirectoryPath}
              onFile={setPreviewPath}
            />
            <Hint>
              Tap a file to preview it. Text and images open in a sheet; other files show their size
              and type.
            </Hint>
          </>
        )}
      </ScreenBody>
      {previewPath === undefined ? undefined : (
        <Sheet
          title={previewPath.split("/").at(-1) ?? previewPath}
          description={
            preview.value === undefined
              ? previewPath
              : `${formatBytes(preview.value.size)} · ${preview.value.mediaType}`
          }
          className="sheet-preview"
          onClose={() => setPreviewPath(undefined)}
        >
          <FilePreview file={preview} />
        </Sheet>
      )}
    </Screen>
  );
}

function DirectoryList({
  listing,
  onDirectory,
  onFile,
}: {
  readonly listing: AsyncState<SkillDirectory> | undefined;
  readonly onDirectory: (path: string) => void;
  readonly onFile: (path: string) => void;
}): ReactElement {
  if (listing?.error !== undefined) {
    return <Banner header="Couldn’t open this folder" subheader={listing.error} />;
  }
  if (listing?.value === undefined) {
    return (
      <div className="resourceLoading">
        <Spinner />
      </div>
    );
  }
  if (listing.value.entries.length === 0) return <Hint>This folder is empty.</Hint>;
  return (
    <Group inset="icon">
      {listing.value.entries.map((entry) => (
        <RowButton
          key={entry.path}
          before={<EntryIcon entry={entry} />}
          label={entry.name}
          value={entry.type === "file" && entry.size !== null ? formatBytes(entry.size) : undefined}
          chevron
          onClick={() =>
            entry.type === "directory" ? onDirectory(entry.path) : onFile(entry.path)
          }
        />
      ))}
    </Group>
  );
}

function EntryIcon({ entry }: { readonly entry: SkillDirectoryEntry }): ReactElement {
  const Icon =
    entry.type === "directory"
      ? Folder
      : entry.name.toLowerCase().endsWith(".md")
        ? FileText
        : File;
  return <Icon className="entryIcon" aria-hidden="true" />;
}

function SkillDetailDesktop({ skill }: { readonly skill: AvailableSkill }): ReactElement {
  const [selectedPath, setSelectedPath] = useState<string>();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const document = useSkillDocument(skill.name);
  const { directories, load } = useDirectoryCache(skill.name);
  const file = useSkillFile(skill.name, selectedPath);
  const root = directories.get("");
  const count = root?.value?.entries.length;
  const toggle = (path: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else {
        next.add(path);
        load(path);
      }
      return next;
    });
  };
  const choose = (path: string): void => setSelectedPath(path === "SKILL.md" ? undefined : path);
  return (
    <>
      <ContentHeader
        crumbs={[
          "Skills",
          <span key="name" className="mono">
            {skill.name}
          </span>,
        ]}
      >
        {count === undefined ? undefined : (
          <span className="contentHeader-status">{`${count} ${count === 1 ? "file" : "files"}`}</span>
        )}
      </ContentHeader>
      <div className="skillDesk">
        <main className="skillDesk-main">
          <div className="skillDesk-column">
            {selectedPath === undefined ? (
              <>
                <p className="skillDesk-description">{skill.description}</p>
                <Instructions document={document} />
              </>
            ) : (
              <>
                <div className="skillDesk-fileHead">
                  <span className="mono">{selectedPath}</span>
                  {file.value === undefined ? undefined : (
                    <span>{`${formatBytes(file.value.size)} · ${file.value.mediaType}`}</span>
                  )}
                </div>
                <FilePreview file={file} />
              </>
            )}
          </div>
        </main>
        <aside className="tree" aria-label="Skill files">
          <div className="tree-label">Files</div>
          {root?.error !== undefined ? (
            <div className="tree-note">{root.error}</div>
          ) : root?.value === undefined ? (
            <div className="tree-note">
              <Spinner />
            </div>
          ) : root.value.entries.length === 0 ? (
            <div className="tree-note">This skill has no bundled files.</div>
          ) : (
            <TreeLevel
              entries={root.value.entries}
              depth={0}
              directories={directories}
              expanded={expanded}
              selectedPath={selectedPath ?? "SKILL.md"}
              onToggle={toggle}
              onChoose={choose}
            />
          )}
        </aside>
      </div>
    </>
  );
}

interface TreeLevelProps {
  readonly entries: readonly SkillDirectoryEntry[];
  readonly depth: number;
  readonly directories: DirectoryCache;
  readonly expanded: ReadonlySet<string>;
  readonly selectedPath: string;
  readonly onToggle: (path: string) => void;
  readonly onChoose: (path: string) => void;
}

function TreeLevel(props: TreeLevelProps): ReactElement {
  return (
    <>
      {props.entries.map((entry) => {
        const isDirectory = entry.type === "directory";
        const open = isDirectory && props.expanded.has(entry.path);
        const listing = open ? props.directories.get(entry.path) : undefined;
        return (
          <div key={entry.path}>
            <button
              type="button"
              className={cn("tree-row", props.selectedPath === entry.path && "tree-selected")}
              style={{ paddingLeft: `${6 + props.depth * 14}px` }}
              aria-expanded={isDirectory ? open : undefined}
              aria-current={props.selectedPath === entry.path ? "true" : undefined}
              onClick={() =>
                isDirectory ? props.onToggle(entry.path) : props.onChoose(entry.path)
              }
            >
              <span className="tree-glyph" aria-hidden="true">
                {isDirectory ? (open ? "▾" : "▸") : ""}
              </span>
              <span className="tree-name">{entry.name}</span>
              {entry.type === "file" && entry.size !== null ? (
                <span className="tree-size">{formatBytes(entry.size)}</span>
              ) : undefined}
            </button>
            {open ? (
              listing?.error !== undefined ? (
                <div className="tree-note" style={{ paddingLeft: `${20 + props.depth * 14}px` }}>
                  {listing.error}
                </div>
              ) : listing?.value === undefined ? (
                <div className="tree-note" style={{ paddingLeft: `${20 + props.depth * 14}px` }}>
                  <Spinner />
                </div>
              ) : listing.value.entries.length === 0 ? (
                <div className="tree-note" style={{ paddingLeft: `${20 + props.depth * 14}px` }}>
                  Empty folder
                </div>
              ) : (
                <TreeLevel {...props} entries={listing.value.entries} depth={props.depth + 1} />
              )
            ) : undefined}
          </div>
        );
      })}
    </>
  );
}

function Instructions({ document }: { readonly document: AsyncState<SkillFile> }): ReactElement {
  if (document.error !== undefined) {
    return <Banner header="Couldn’t read SKILL.md" subheader={document.error} />;
  }
  if (document.value === undefined) {
    return (
      <div className="resourceLoading">
        <Spinner />
      </div>
    );
  }
  return renderMarkdown(document.value.content, true);
}

function FilePreview({ file }: { readonly file: AsyncState<SkillFile> }): ReactNode {
  if (file.error !== undefined) {
    return <Banner header="Couldn’t preview this file" subheader={file.error} />;
  }
  const value = file.value;
  if (value === undefined) {
    return (
      <div className="resourceLoading">
        <Spinner />
      </div>
    );
  }
  if (value.encoding === "utf8") {
    return value.mediaType === "text/markdown" || value.path.toLowerCase().endsWith(".md") ? (
      renderMarkdown(value.content)
    ) : (
      <pre className="source">{value.content}</pre>
    );
  }
  if (value.mediaType.startsWith("image/")) {
    return (
      <div className="imagePreview">
        <img src={`data:${value.mediaType};base64,${value.content}`} alt={value.path} />
      </div>
    );
  }
  return <Hint>This binary file can be browsed, but it cannot be previewed here.</Hint>;
}

function renderMarkdown(content: string, stripFrontmatter = false): ReactElement {
  const markdown = stripFrontmatter
    ? content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "")
    : content;
  return (
    <div className="prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
    </div>
  );
}

function parentDirectory(path: string): string {
  const parts = path.split("/").filter((part) => part.length > 0);
  parts.pop();
  return parts.join("/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_024 * 1_024) return `${(bytes / 1_024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / 1_024 / 1_024).toFixed(1)} MB`;
}
