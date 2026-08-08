import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import userEvent from "@testing-library/user-event";
import BlockButton from "./components/BlockButton.jsx";
import ConnectButton from "./components/ConnectButton.jsx";
import DisconnectWarningModal from "./components/DisconnectWarningModal.jsx";
import { api } from "./api.js";
import { unauthoredError, failRefetch } from "./test-utils.jsx";

/**
 * When a failure message on the Block / Connect controls is allowed to *retire*
 * (issue #236, following the discipline #229 settled on).
 *
 * These live apart from the profile tests in `messaging.test.jsx` because what
 * they pin is the button reacting to the server's answer changing *underneath a
 * mounted component* — the case that makes a stale message possible at all.
 * Driving that through the whole app would navigate, which remounts the button
 * and takes the state with it, proving nothing. Here the server's answer is just
 * a prop, so it can move while the component stays put.
 *
 * The rule, both halves of it:
 *
 *   - The message goes when the server moves to the answer the attempt was
 *     reaching for — the request landed and only its response was lost, so the
 *     message would now be sitting under the very thing it denies. On the block
 *     that stale sentence is a false claim about someone's safety.
 *   - It stays for any *other* answer. A refetch bearing some third status isn't
 *     confirmation of your attempt, and clearing on any resync is the swallow
 *     issue #231 describes.
 */
vi.mock("./api.js", () => ({
  api: {
    connect: vi.fn(),
    disconnect: vi.fn(),
    blockUser: vi.fn(),
    unblockUser: vi.fn(),
    getDisconnectImpact: vi.fn(),
  },
}));

/** Render a control, and hand back a rerender that keeps the same provider. */
function renderButton(ui) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (node) => (
    <QueryClientProvider client={queryClient}>{node}</QueryClientProvider>
  );
  const utils = render(wrap(ui));
  return {
    ...utils,
    queryClient,
    setProps: (node) => utils.rerender(wrap(node)),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getDisconnectImpact.mockResolvedValue({ chats: [] });
});

describe("BlockButton", () => {
  async function failABlock(user) {
    api.blockUser.mockRejectedValue(unauthoredError(500));
    const utils = renderButton(
      <BlockButton userId={2} displayName="Priya" isBlocked={false} />
    );

    await user.click(screen.getByRole("button", { name: "Block" }));
    const dialog = await screen.findByRole("dialog", {
      name: /block confirmation/i,
    });
    await user.click(within(dialog).getByRole("button", { name: "Confirm" }));
    await within(dialog).findByText(/they’re not blocked/);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("alert")).toBeInTheDocument();
    return utils;
  }

  it("retires the message once the server says the block landed after all", async () => {
    const user = userEvent.setup();
    const { setProps } = await failABlock(user);

    // The POST did land; only its response was lost, and the profile's refetch
    // hands down the newer truth.
    setProps(<BlockButton userId={2} displayName="Priya" isBlocked />);

    expect(screen.getByRole("button", { name: "Unblock" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the message while the server still says they are not blocked", async () => {
    const user = userEvent.setup();
    const { setProps } = await failABlock(user);

    // A refetch that confirms nothing changed is not confirmation of anything.
    setProps(
      <BlockButton userId={2} displayName="Priya" isBlocked={false} />
    );

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t block Priya — they’re not blocked. Try again."
    );
  });
});

describe("ConnectButton", () => {
  async function failAWithdraw(user) {
    api.disconnect.mockRejectedValue(new TypeError("Failed to fetch"));
    const utils = renderButton(
      <ConnectButton userId={2} displayName="Priya" connectionStatus="requested" />
    );

    await user.click(screen.getByRole("button", { name: "Requested" }));
    expect(
      await screen.findByText("Couldn’t withdraw that request — try again.")
    ).toBeInTheDocument();
    return utils;
  }

  it("retires the message once the request is actually gone", async () => {
    const user = userEvent.setup();
    const { setProps } = await failAWithdraw(user);

    setProps(
      <ConnectButton userId={2} displayName="Priya" connectionStatus="none" />
    );

    expect(screen.getByRole("button", { name: "Connect" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps the message when the server moves to some third answer", async () => {
    const user = userEvent.setup();
    const { setProps } = await failAWithdraw(user);

    // They accepted while your withdraw was failing. Your withdraw still didn't
    // happen, so the message is still true and still yours to see.
    setProps(
      <ConnectButton userId={2} displayName="Priya" connectionStatus="connected" />
    );

    expect(screen.getByRole("button", { name: "Connected" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Couldn’t withdraw that request — try again."
    );
  });
});

/**
 * Issue #310, at the site where getting it wrong is most expensive.
 *
 * The list of group chats a disconnect will throw you out of is the entire
 * reason this modal exists. `query-core`'s error action keeps `data` and only
 * flips `status`, and this key is refetched on every open (`staleTime` is 0) —
 * so testing `isError` above the list handed you "You can still continue" with
 * the concrete warning sitting unread in the cache, and Confirm live.
 */
describe("DisconnectWarningModal — a failed re-check keeps the warning", () => {
  const impact = {
    chats: [
      { id: 4, title: "Book Club" },
      { id: 9, title: "Sunday lunch" },
    ],
  };

  function renderModal() {
    return renderButton(
      <DisconnectWarningModal
        userId={2}
        userName="Priya"
        action="disconnect"
        onConfirm={() => {}}
        onCancel={() => {}}
      />
    );
  }

  it("still names the chats when the re-check fails", async () => {
    api.getDisconnectImpact.mockResolvedValue(impact);
    const { queryClient } = renderModal();
    await screen.findByText("Book Club");

    api.getDisconnectImpact.mockRejectedValue(unauthoredError(500));
    await failRefetch(queryClient, ["disconnect-impact", 2]);

    expect(screen.getByText("Book Club")).toBeInTheDocument();
    expect(screen.getByText("Sunday lunch")).toBeInTheDocument();
    expect(screen.queryByText(/You can still continue/)).toBeNull();
  });

  it("says it couldn't check when there is nothing cached to show", async () => {
    api.getDisconnectImpact.mockRejectedValue(unauthoredError(500));
    renderModal();

    expect(
      await screen.findByText(/Couldn’t check for shared chats/)
    ).toBeInTheDocument();
  });
});
