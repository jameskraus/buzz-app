import { NavigationItem } from "../../shared/design-system/ui/NavigationItem";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconButton } from "../../shared/design-system/ui/IconButton";
import { SidebarIcon } from "../../shared/design-system/icons";
import { Panel } from "../../shared/design-system/ui/Panel";
import { isTauri } from "@tauri-apps/api/core";
import type { RegisteredPage } from "../../features/pages/service";
import type { AccountActionsService } from "../../features/account-actions/service";
import type { Communities } from "../../features/communities/service";
import { CommunityRail } from "../../features/communities/CommunityRail";
import { ProfileButton } from "./ProfileButton";
import { PageSearch, type SearchServices } from "./PageSearch";
import { orderPages, pagePresentation } from "./presentation";
import { PanelFrame } from "../../features/panels/PanelFrame";
import { macTitleBarDragHandlers } from "./title-bar";

const macDesktop = isTauri() && /Mac/i.test(navigator.platform);
const titleBarDragProps = macDesktop ? macTitleBarDragHandlers : {};

export function AppShell({
  pages,
  selected,
  navigationAttempt,
  onSelect,
  tone,
  workspace,
  sidebar,
  communities,
  accountActions,
  searchServices,
  navigationControls,
  onCommunitySelect,
  launchers,
  companion,
  children,
}: {
  pages: readonly RegisteredPage[];
  selected: string;
  navigationAttempt: string;
  onSelect: (key: string) => void;
  tone: string;
  workspace?: boolean;
  sidebar?: (pages: ReactNode) => ReactNode;
  communities: Communities;
  accountActions: AccountActionsService;
  searchServices?: SearchServices;
  navigationControls?: ReactNode;
  onCommunitySelect?: (id: string | null) => void;
  launchers?: ReactNode;
  companion?: ReactNode;
  children: ReactNode;
}) {
  const fillsWorkspace = workspace || selected === "settings";
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationToggle = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Only a new navigation attempt closes the drawer; opening the disclosure must not retrigger this effect.
  useEffect(() => {
    if (navigationOpen && navigationToggle.current?.getClientRects().length) {
      document.getElementById("main-content")?.focus({ preventScroll: true });
    }
    setNavigationOpen(false);
  }, [navigationAttempt]);
  const pageNavigation = (
    <nav aria-label="Pages" className="shell-pages">
      {orderPages(pages).map((page) => {
        const { label, icon: Icon } = pagePresentation(page);
        return (
          <NavigationItem
            type="button"
            key={page.key}
            onClick={() => {
              onSelect(page.key);
              document
                .getElementById("main-content")
                ?.focus({ preventScroll: true });
            }}
            selected={selected === page.key}
            label={label}
            icon={
              <span className="shell-page-icon">
                <Icon aria-hidden="true" weight="bold" size={15} />
              </span>
            }
          />
        );
      })}
    </nav>
  );
  return (
    <div
      data-shell-tone={tone}
      className="shell-background flex h-dvh min-h-0 flex-col overflow-hidden bg-shell text-ink"
    >
      {/* biome-ignore lint/a11y/useValidAnchor: A skip link navigates to a real fragment; enhance focus without replacing the app route hash. */}
      <a
        href="#main-content"
        onClick={(event) => {
          // Focus intent is not a navigation visit and must not replace the route hash.
          event.preventDefault();
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:rounded-lg focus:bg-surface focus:p-3"
      >
        Skip to content
      </a>
      <header
        data-tauri-drag-region={macDesktop ? undefined : true}
        {...titleBarDragProps}
        className={`shell-header ${macDesktop ? "shell-header-mac" : ""}`}
      >
        <div
          className="shell-communities"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {navigationControls}
          <span className="shell-navigation-toggle">
            <IconButton
              ref={navigationToggle}
              aria-label={
                navigationOpen ? "Hide navigation" : "Show navigation"
              }
              aria-expanded={navigationOpen}
              aria-controls="shell-navigation"
              onClick={() => setNavigationOpen((open) => !open)}
              icon={<SidebarIcon aria-hidden="true" size={20} />}
            />
          </span>
        </div>
        <div
          className="shell-actions"
          data-tauri-drag-region={macDesktop ? undefined : true}
          {...titleBarDragProps}
        >
          {launchers}
          <PageSearch
            pages={pages}
            onSelect={onSelect}
            services={searchServices}
          />
          <ProfileButton
            communities={communities}
            accountActions={accountActions}
            settingsSelected={selected === "settings"}
            onSettings={() => onSelect("settings")}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <CommunityRail communities={communities} onSelect={onCommunitySelect} />
        <div
          className={`shell-body ${selected === "settings" ? "shell-body-settings" : ""}`}
        >
          {/* biome-ignore lint/a11y/noStaticElementInteractions: Delegated Escape from descendant controls closes the disclosure; the layout wrapper is not itself interactive. */}
          <div
            id="shell-navigation"
            className="shell-navigation"
            data-expanded={navigationOpen}
            onKeyDown={(event) => {
              if (
                event.key === "Escape" &&
                navigationOpen &&
                !event.defaultPrevented
              ) {
                setNavigationOpen(false);
                navigationToggle.current?.focus();
              }
            }}
          >
            {sidebar ? (
              sidebar(pageNavigation)
            ) : (
              <div className="shell-sidebar-default">
                <Panel as="aside" aria-label="Page sidebar">
                  <div className="p-2">{pageNavigation}</div>
                </Panel>
              </div>
            )}
          </div>
          <main
            id="main-content"
            tabIndex={-1}
            className="min-h-0 min-w-0 flex-1 overflow-hidden"
          >
            <PanelFrame companion={companion}>
              <div
                className={
                  fillsWorkspace
                    ? "h-full min-h-0"
                    : "h-full min-h-0 overflow-y-auto px-2 pt-10 pb-8 sm:px-4 sm:pt-14 sm:pb-10"
                }
              >
                <div
                  className={
                    fillsWorkspace
                      ? "h-full min-h-0"
                      : "mx-auto w-full max-w-4xl"
                  }
                >
                  {children}
                </div>
              </div>
            </PanelFrame>
          </main>
        </div>
      </div>
    </div>
  );
}
