import * as React from "react";
import { sectionNavigation, type NavigationLink } from "./workspace-navigation";
import { TabTrack } from "./tab-track";

// Route tabs: real links with aria-current (not ARIA tabs), so Back/Forward, new tabs and
// deep links work. The track scrolls on its own when the row is wider than the screen, keeps
// the current tab in view and fades the clipped edge. `data-label` lets the stylesheet reserve
// the bold width of every label, so the selected tab's weight never shifts its neighbours.
export function NavigationTabs({
  label,
  items,
  secondary = false,
}: {
  label: string;
  items: readonly NavigationLink[];
  secondary?: boolean;
}) {
  return (
    <TabTrack
      as="nav"
      aria-label={label}
      className={secondary ? "wh-subtabs" : "wh-tabs"}
      current={items.find((item) => item.active)?.href}
    >
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={secondary ? "wh-subtab" : "wh-tab"}
          data-label={secondary ? undefined : item.label}
        >
          {item.label}
        </a>
      ))}
    </TabTrack>
  );
}

// The section's route tabs as a full-width bar under the top bar. Its track shares the page
// measure (surfaces.css), so the first tab starts on the content's left edge.
export function SectionNavigation({ pathname }: { pathname: string }) {
  const nav = sectionNavigation(pathname);
  return nav.items.length ? (
    <div className="wh-section-navigation">
      <NavigationTabs label={`${nav.label} sections`} items={nav.items} />
    </div>
  ) : null;
}
