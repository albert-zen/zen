import React, {
  Children,
  isValidElement,
  useId,
  useState,
  useRef,
  type ReactNode,
  type ComponentProps,
} from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Icon } from "../icons.js";

interface Choice {
  value: string;
  label: ReactNode;
  disabled?: boolean;
  group?: string;
}
function choiceText(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? choiceText(child.props.children)
        : String(child),
    )
    .join("");
}
function choices(children: ReactNode, group?: string): Choice[] {
  return Children.toArray(children).flatMap((child): Choice[] => {
    if (
      !isValidElement<{
        value?: string | number;
        children?: ReactNode;
        disabled?: boolean;
        label?: string;
      }>(child)
    )
      return [];
    if (child.type === "option")
      return [
        {
          value: String(child.props.value ?? ""),
          label: child.props.children,
          disabled: child.props.disabled,
          group,
        },
      ];
    return choices(
      child.props.children,
      child.type === "optgroup" ? child.props.label : group,
    );
  });
}

/** Value selection, with typeahead, roving focus and viewport-aware positioning. */
export function Select({
  value,
  onValueChange,
  children,
  disabled,
  className = "",
  ...props
}: Omit<
  ComponentProps<typeof SelectPrimitive.Trigger>,
  "children" | "value" | "onChange" | "defaultValue"
> & {
  value: string | number;
  onValueChange(value: string): void;
  children: ReactNode;
}) {
  const items = choices(children);
  const selected = items.find((item) => item.value === String(value));
  const id = useId();
  return (
    <SelectPrimitive.Root
      value={`value:${String(value)}`}
      onValueChange={(next) => onValueChange(next.slice("value:".length))}
      disabled={disabled}
    >
      <SelectPrimitive.Trigger
        {...props}
        data-value={value}
        id={props.id ?? id}
        className={`ui-select ${className}`}
        title={
          props.title ??
          (typeof selected?.label === "string" ? selected.label : undefined)
        }
      >
        <SelectPrimitive.Value>
          {selected?.label ?? "Unavailable selection"}
        </SelectPrimitive.Value>
        <SelectPrimitive.Icon>
          <Icon name="chevron-down" size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className="ui-select-popover"
          position="popper"
          sideOffset={5}
          collisionPadding={10}
        >
          <SelectPrimitive.ScrollUpButton className="ui-select-scroll">
            ↑
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport>
            {items.map((item, index) => (
              <SelectPrimitive.Group key={`${item.value}:${index}`}>
                {item.group && items[index - 1]?.group !== item.group ? (
                  <SelectPrimitive.Label className="ui-select-group">
                    {item.group}
                  </SelectPrimitive.Label>
                ) : null}
                <SelectPrimitive.Item
                  data-value={item.value}
                  value={`value:${item.value}`}
                  disabled={item.disabled}
                  className="ui-select-option"
                >
                  <SelectPrimitive.ItemText>
                    {item.label}
                  </SelectPrimitive.ItemText>
                  <SelectPrimitive.ItemIndicator>
                    <Icon name="check" size={14} />
                  </SelectPrimitive.ItemIndicator>
                </SelectPrimitive.Item>
              </SelectPrimitive.Group>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className="ui-select-scroll">
            ↓
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export function PopoverContent({
  children,
  className = "",
  ...props
}: ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        side="top"
        align="start"
        sideOffset={6}
        collisionPadding={10}
        {...props}
        className={`ui-popover ${className}`}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
}

export function ActionMenu({
  label,
  items,
}: {
  label: string;
  items: Array<{
    label: string;
    disabled?: boolean;
    danger?: boolean;
    description?: string;
    onSelect(): void;
  }>;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const selected = useRef(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          type="button"
          className="quiet-button"
          aria-label={label}
          aria-haspopup="menu"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
            }
          }}
        >
          More actions
          <Icon name="chevron-down" size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        ref={menu}
        role="menu"
        aria-label={label}
        side="bottom"
        align="end"
        className="ui-action-menu"
        onCloseAutoFocus={(event) => {
          if (selected.current) event.preventDefault();
          selected.current = false;
        }}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          menu.current
            ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
            ?.focus();
        }}
        onKeyDown={(event) => {
          if (event.key === "Tab") {
            selected.current = true;
            trigger.current?.focus();
            setOpen(false);
            return;
          }
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
            return;
          event.preventDefault();
          const buttons = Array.from(
            menu.current?.querySelectorAll<HTMLButtonElement>(
              "button:not(:disabled)",
            ) ?? [],
          );
          const current = buttons.indexOf(
            document.activeElement as HTMLButtonElement,
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (current +
                    (event.key === "ArrowUp" ? -1 : 1) +
                    buttons.length) %
                  buttons.length;
          buttons[next]?.focus();
        }}
      >
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            type="button"
            className={`ui-action-item${item.danger ? " is-danger" : ""}`}
            disabled={item.disabled}
            title={item.description}
            onClick={() => {
              selected.current = true;
              setOpen(false);
              item.onSelect();
            }}
          >
            <strong>{item.label}</strong>
            {item.description ? <small>{item.description}</small> : null}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

/** Searchable choice list for long model/thread catalogues; never accepts an invented value. */
export function Combobox({
  value,
  onValueChange,
  children,
  label,
  disabled = false,
  autoFocus = false,
}: {
  value: string;
  onValueChange(value: string): void;
  children: ReactNode;
  label: string;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const tabDismissed = useRef(false);
  const [cursor, setCursor] = useState(0);
  const id = useId();
  const items = choices(children);
  const filtered = items.filter(
    (item) =>
      !item.disabled &&
      `${choiceText(item.label)} ${item.group ?? ""}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const choose = (next: string) => {
    onValueChange(next);
    setOpen(false);
  };
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        setCursor(0);
      }}
    >
      <PopoverTrigger asChild>
        <button
          ref={trigger}
          autoFocus={autoFocus}
          type="button"
          className="ui-select"
          data-value={value}
          disabled={disabled}
          aria-label={label}
          aria-describedby={`${id}-value`}
          aria-haspopup="listbox"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setQuery("");
              setCursor(0);
            }
          }}
        >
          <span id={`${id}-value`}>
            {items.find((item) => item.value === value)?.label ??
              (value ? "Unavailable selection" : "Choose…")}
          </span>
          <Icon name="chevron-down" size={14} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        className="ui-combobox"
        side="bottom"
        onCloseAutoFocus={(event) => {
          const active = document.activeElement;
          // A different field may already own focus when the exit finishes.
          // Do not close that field's popup by restoring an older trigger.
          if (
            tabDismissed.current ||
            (active !== document.body &&
              active !== trigger.current &&
              !(event.target as HTMLElement | null)?.contains(active))
          )
            event.preventDefault();
          tabDismissed.current = false;
        }}
      >
        <input
          autoFocus
          role="combobox"
          aria-label={`Search ${label.toLowerCase()}`}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={id}
          aria-activedescendant={
            filtered[cursor] ? `${id}-${cursor}` : undefined
          }
          value={query}
          placeholder="Search…"
          onChange={(event) => {
            setQuery(event.target.value);
            setCursor(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Tab") {
              tabDismissed.current = true;
              trigger.current?.focus();
              setOpen(false);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const next = filtered.length
                ? (cursor +
                    (event.key === "ArrowDown" ? 1 : -1) +
                    filtered.length) %
                  filtered.length
                : 0;
              setCursor(next);
              document
                .getElementById(`${id}-${next}`)
                ?.scrollIntoView({ block: "nearest" });
            } else if (event.key === "Enter" && filtered[cursor]) {
              event.preventDefault();
              choose(filtered[cursor]!.value);
            }
          }}
        />
        <div
          role="listbox"
          id={id}
          aria-label={label}
          className="ui-combobox-options"
        >
          {filtered.map((item, index) => (
            <div
              key={item.value}
              id={`${id}-${index}`}
              role="option"
              data-value={item.value}
              aria-selected={item.value === value}
              data-highlighted={cursor === index ? "" : undefined}
              className="ui-select-option"
              onPointerMove={() => setCursor(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(item.value)}
            >
              <span>{item.label}</span>
              {item.value === value ? <Icon name="check" size={14} /> : null}
            </div>
          ))}
        </div>
        {!filtered.length ? <p role="status">No matching options.</p> : null}
      </PopoverContent>
    </Popover>
  );
}

/** Controlled modal shell; callers retain their draft and submission semantics. */
export function Dialog({
  open,
  onOpenChange,
  title,
  children,
  className = "",
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  children: ReactNode;
  className?: string;
}) {
  const restoreFocus = useRef<HTMLElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="ui-dialog-overlay" />
        <DialogPrimitive.Content
          className={`ui-dialog ${className}`}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            restoreFocus.current = document.activeElement as HTMLElement | null;
            const input = (event.target as HTMLElement | null)?.querySelector(
              "input",
            );
            if (input instanceof HTMLElement) {
              event.preventDefault();
              input.focus();
            }
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            restoreFocus.current?.focus();
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
