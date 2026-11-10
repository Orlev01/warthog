import * as React from "react";
import { sectionNavigation, type NavigationLink } from "./workspace-navigation";

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
    <nav aria-label={label} className={secondary ? "wh-subtabs" : "wh-tabs"}>
      {items.map((item) => (
        <a
          key={item.href}
          href={item.href}
          aria-current={item.active ? "page" : undefined}
          className={secondary ? "wh-subtab" : "wh-tab"}
        >
          {item.label}
        </a>
      ))}
    </nav>
  );
}
export function SectionNavigation({ pathname }: { pathname: string }) {
  const nav = sectionNavigation(pathname);
  return nav.items.length ? (
    <div className="wh-section-navigation">
      <NavigationTabs label={`${nav.label} sections`} items={nav.items} />
    </div>
  ) : null;
}
