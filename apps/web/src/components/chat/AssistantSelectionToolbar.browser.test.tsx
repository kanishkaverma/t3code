import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  EnvironmentId,
  MessageId,
  ThreadId,
  type AssistantCitation,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "@t3tools/shared/keybindings";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { AssistantCitationSourceAnchor } from "~/lib/assistantTextSelection";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { act, render } from "../../../test/render";

const mockKeybindings = vi.hoisted(() => ({
  atom: null as Atom.Writable<ResolvedKeybindingsConfig> | null,
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom: ReactivityAtom } = await import("effect/reactivity");
  const { DEFAULT_RESOLVED_KEYBINDINGS: defaults } = await import("@t3tools/shared/keybindings");
  const atom = ReactivityAtom.make<ResolvedKeybindingsConfig>(defaults).pipe(
    ReactivityAtom.keepAlive,
  );
  mockKeybindings.atom = atom;
  return {
    ...actual,
    primaryServerKeybindingsAtom: atom,
  };
});

import { AssistantSelectionToolbar } from "./AssistantSelectionToolbar";
import { BackgroundThreadContext } from "./backgroundThread";

const threadRef = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};

function setKeybindings(config: ResolvedKeybindingsConfig) {
  if (!mockKeybindings.atom) throw new Error("Expected mocked keybindings atom");
  appAtomRegistry.set(mockKeybindings.atom, config);
}

function selectTextIn(element: Element, start = 0, end?: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const textNode = walker.nextNode();
  if (!textNode) throw new Error("Expected a text node to select");
  const range = document.createRange();
  range.setStart(textNode, start);
  range.setEnd(textNode, end ?? textNode.textContent?.length ?? 0);
  const selection = window.getSelection();
  if (!selection) throw new Error("Missing window selection");
  selection.removeAllRanges();
  selection.addRange(range);
}

function pressShortcut(
  init: KeyboardEventInit,
  target: EventTarget = document.body,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function Harness({
  text = "Hello world from assistant",
  backgroundThread = false,
  onCite,
}: {
  text?: string;
  backgroundThread?: boolean;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [viewport, setViewport] = useState<HTMLDivElement | null>(null);
  return (
    <AppAtomRegistryProvider>
      <BackgroundThreadContext value={backgroundThread}>
        <div>
          <div ref={setViewport} data-testid="viewport">
            <p data-assistant-citation-source={MessageId.make("msg-1")}>{text}</p>
          </div>
          <p data-testid="outside">Outside assistant text</p>
          <AssistantSelectionToolbar viewport={viewport} threadRef={threadRef} onCite={onCite} />
        </div>
      </BackgroundThreadContext>
    </AppAtomRegistryProvider>
  );
}

function DualViewportHarness({
  onCiteMain,
  onCiteSide,
}: {
  onCiteMain: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
  onCiteSide: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [mainViewport, setMainViewport] = useState<HTMLDivElement | null>(null);
  const [sideViewport, setSideViewport] = useState<HTMLDivElement | null>(null);
  return (
    <AppAtomRegistryProvider>
      <div>
        <div ref={setMainViewport} data-testid="main-viewport">
          <p data-assistant-citation-source={MessageId.make("msg-main")}>Main assistant reply</p>
        </div>
        <AssistantSelectionToolbar
          viewport={mainViewport}
          threadRef={threadRef}
          onCite={onCiteMain}
        />
        <div ref={setSideViewport} data-testid="side-viewport">
          <p data-assistant-citation-source={MessageId.make("msg-side")}>Side assistant reply</p>
        </div>
        <AssistantSelectionToolbar
          viewport={sideViewport}
          threadRef={{
            environmentId: threadRef.environmentId,
            threadId: ThreadId.make("thread-side"),
          }}
          onCite={onCiteSide}
        />
      </div>
    </AppAtomRegistryProvider>
  );
}

describe("AssistantSelectionToolbar keyboard shortcut", () => {
  it("cites selected assistant text with mod+e, clears the selection, and displays the shortcut hint", async () => {
    setKeybindings(DEFAULT_RESOLVED_KEYBINDINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onCite = vi.fn(() => true);
    // Isolated toolbar fixture does not need router context.
    await using screen = await render(<Harness onCite={onCite} />, { router: false });

    const source = screen.getByText("Hello world from assistant").element();
    await act(() => {
      source.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      selectTextIn(source, 6, 11);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });

    const citeButton = page.getByRole("button", { name: "Cite selection in composer" });
    await expect.element(citeButton).toBeVisible();
    expect(citeButton.element().querySelector("[data-slot='kbd']")?.textContent).toBe("⌘E");

    const event = pressShortcut({ key: "e", code: "KeyE", metaKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledOnce();
    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: threadRef.threadId,
        messageId: MessageId.make("msg-1"),
        text: "world",
      }),
      expect.objectContaining({ source }),
    );
    expect(window.getSelection()?.isCollapsed).toBe(true);
    await expect.element(citeButton).not.toBeInTheDocument();
  });

  it("cites immediately after selecting text even before the floating toolbar renders or after Escape", async () => {
    setKeybindings(DEFAULT_RESOLVED_KEYBINDINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
    const onCite = vi.fn(() => true);
    // Isolated toolbar fixture does not need router context.
    await using screen = await render(<Harness onCite={onCite} />, { router: false });

    const source = screen.getByText("Hello world from assistant").element();
    selectTextIn(source, 0, 5);

    const immediateEvent = pressShortcut({ key: "e", code: "KeyE", ctrlKey: true });
    expect(immediateEvent.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Hello" }),
      expect.objectContaining({ source }),
    );

    onCite.mockClear();
    await act(() => {
      source.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      selectTextIn(source, 6, 11);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
    const citeButton = page.getByRole("button", { name: "Cite selection in composer" });
    await expect.element(citeButton).toBeVisible();

    await act(() => {
      pressShortcut({ key: "Escape" });
    });
    await expect.element(citeButton).not.toBeInTheDocument();

    const afterEscapeEvent = pressShortcut({ key: "e", code: "KeyE", ctrlKey: true });
    expect(afterEscapeEvent.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledWith(
      expect.objectContaining({ text: "world" }),
      expect.objectContaining({ source }),
    );
  });

  it("leaves mod+e alone when no assistant text is selected or the selection is too long", async () => {
    setKeybindings(DEFAULT_RESOLVED_KEYBINDINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onCite = vi.fn(() => true);
    const longText = "a".repeat(ASSISTANT_CITATION_MAX_TEXT_LENGTH + 10);
    // Isolated toolbar fixture does not need router context.
    await using screen = await render(<Harness text={longText} onCite={onCite} />, {
      router: false,
    });

    window.getSelection()?.removeAllRanges();
    const collapsedEvent = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(collapsedEvent.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();

    selectTextIn(screen.getByTestId("outside").element());
    const outsideEvent = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(outsideEvent.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();

    const source = screen.getByText(longText).element();
    selectTextIn(source);
    const tooLongEvent = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(tooLongEvent.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("honors custom rebound and unassigned keybindings", async () => {
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onCite = vi.fn(() => true);
    setKeybindings(
      mergeWithDefaultKeybindings(
        compileResolvedKeybindingsConfig([
          {
            key: "mod+shift+q",
            command: "chat.citeSelection",
            when: "!terminalFocus && !previewFocus",
          },
        ]),
      ),
    );
    // Isolated toolbar fixture does not need router context.
    await using screen = await render(<Harness onCite={onCite} />, { router: false });

    const source = screen.getByText("Hello world from assistant").element();
    await act(() => {
      selectTextIn(source, 0, 5);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const citeButton = page.getByRole("button", { name: "Cite selection in composer" });
    await expect.element(citeButton).toBeVisible();
    expect(citeButton.element().querySelector("[data-slot='kbd']")?.textContent).toBe("⇧⌘Q");

    const oldDefault = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(oldDefault.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();

    const custom = pressShortcut({ key: "Q", code: "KeyQ", metaKey: true, shiftKey: true });
    expect(custom.defaultPrevented).toBe(true);
    expect(onCite).toHaveBeenCalledOnce();

    onCite.mockClear();
    await act(() => {
      setKeybindings(
        mergeWithDefaultKeybindings(
          compileResolvedKeybindingsConfig([
            { key: "mod+e", command: "chat.citeSelection", when: "false" },
          ]),
        ),
      );
      source.dispatchEvent(
        new PointerEvent("pointerdown", { bubbles: true, isPrimary: true, button: 0 }),
      );
      selectTextIn(source, 6, 11);
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    });
    await expect.element(citeButton).toBeVisible();
    expect(citeButton.element().querySelector("[data-slot='kbd']")).toBeNull();

    const unassigned = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(unassigned.defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();
  });

  it("routes mod+e to the viewport that owns the selection when two toolbars are mounted", async () => {
    setKeybindings(DEFAULT_RESOLVED_KEYBINDINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onCiteMain = vi.fn(() => true);
    const onCiteSide = vi.fn(() => true);
    // Isolated toolbar fixture does not need router context.
    await using screen = await render(
      <DualViewportHarness onCiteMain={onCiteMain} onCiteSide={onCiteSide} />,
      { router: false },
    );

    selectTextIn(screen.getByText("Main assistant reply").element(), 0, 4);
    const mainEvent = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(mainEvent.defaultPrevented).toBe(true);
    expect(onCiteMain).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: MessageId.make("msg-main"), text: "Main" }),
      expect.anything(),
    );
    expect(onCiteSide).not.toHaveBeenCalled();

    selectTextIn(screen.getByText("Side assistant reply").element(), 0, 4);
    const sideEvent = pressShortcut({ key: "e", code: "KeyE", metaKey: true });
    expect(sideEvent.defaultPrevented).toBe(true);
    expect(onCiteSide).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: MessageId.make("msg-side"), text: "Side" }),
      expect.anything(),
    );
  });

  it("ignores background threads, repeat events, and IME composition", async () => {
    setKeybindings(DEFAULT_RESOLVED_KEYBINDINGS);
    using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    const onCite = vi.fn(() => true);
    // Isolated toolbar fixture does not need router context.
    await using screen = await render(<Harness backgroundThread onCite={onCite} />, {
      router: false,
    });

    const source = screen.getByText("Hello world from assistant").element();
    selectTextIn(source, 0, 5);
    expect(pressShortcut({ key: "e", code: "KeyE", metaKey: true }).defaultPrevented).toBe(false);
    expect(onCite).not.toHaveBeenCalled();

    await screen.rerender(<Harness backgroundThread={false} onCite={onCite} />);
    expect(
      pressShortcut({ key: "e", code: "KeyE", metaKey: true, repeat: true }).defaultPrevented,
    ).toBe(false);
    expect(
      pressShortcut({ key: "e", code: "KeyE", metaKey: true, isComposing: true }).defaultPrevented,
    ).toBe(false);
    expect(onCite).not.toHaveBeenCalled();
  });
});
