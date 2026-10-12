import React, { useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import {
  Alert,
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { createSession, type Host } from "./session.mjs";
import { createAppActions } from "./app-actions.mjs";
import { fixtureHosts } from "./fixture.mjs";
import {
  deviceStatus,
  FLEET_ADDRESSES_KEY,
  FLEET_PREFERENCE_KEY,
  makeHost,
  MAX_REMOTE_HOSTS,
  readSavedHosts,
  reconnectAvailable,
  saveHosts,
} from "./fleet.mjs";
import { combinedTransport, setHostList, transport } from "./transport";

type ScreenState = ReturnType<ReturnType<typeof createSession>["get"]>;
type Pane = "fleet" | "threads" | "rooms";
const fixtureId = fixtureHosts[0].id;
const colors = {
  bg: "#101524",
  card: "#1b2335",
  text: "#f2f5ff",
  muted: "#aab9d0",
  accent: "#82dfbf",
  warn: "#ffc482",
};

export default function App() {
  const [screen, setScreen] = useState<ScreenState | null>(null);
  const [pane, setPane] = useState<Pane>("fleet");
  const [draft, setDraft] = useState("");
  const [address, setAddress] = useState("");
  const [hostId, setHostId] = useState("");
  const [hostName, setHostName] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [editedName, setEditedName] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairState, setPairState] = useState<string | null>(null);
  const [hosts, setHosts] = useState<Host[]>(fixtureHosts);
  const [pairings, setPairings] = useState<Record<string, string>>({});
  const [storageError, setStorageError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const userSelected = useRef(false);
  const fleetBusy = useRef(false);
  const pairingBusy = useRef(false);
  const hostsRef = useRef(hosts);
  const preferenceWrites = useRef(Promise.resolve());
  const draftRef = useRef("");
  const pairCodeRef = useRef("");
  const updateDraft = (value: string) => {
    draftRef.current = value;
    setDraft(value);
  };
  const updatePairCode = (value: string) => {
    pairCodeRef.current = value;
    setPairCode(value);
  };
  const session = useMemo(
    () => createSession(combinedTransport, setScreen),
    [],
  );
  const actions = useMemo(
    () =>
      createAppActions(session, transport, {
        getDraft: () => draftRef.current,
        setDraft: updateDraft,
        getPairCode: () => pairCodeRef.current,
        setPairCode: updatePairCode,
        setPairState,
      }),
    [session],
  );
  const s = screen ?? session.get();
  const selectedHost = hosts.find((host) => host.id === s.host);
  const selectedWorkspace = s.workspaces.find(
    (workspace) => workspace.id === s.workspace,
  );
  const selectedThread = s.threads.find((thread) => thread.id === s.thread);
  const selectedRoom = s.rooms.find((room) => room.id === s.room);
  const isFixture = s.host === fixtureId;
  const connected = s.status === "connected";
  const blocked =
    !connected ||
    isFixture ||
    s.command === "pending" ||
    s.command === "uncertain";

  function replaceHosts(next: Host[]) {
    hostsRef.current = next;
    setHostList(next);
    session.setHosts(next);
    setHosts(next);
  }
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    let active = true;
    Promise.all([
      SecureStore.getItemAsync(FLEET_PREFERENCE_KEY),
      SecureStore.getItemAsync(FLEET_ADDRESSES_KEY),
    ])
      .then(([selected, saved]) => {
        if (!active) return;
        const list = [...fixtureHosts, ...readSavedHosts(saved, [fixtureId])];
        replaceHosts(list);
        if (
          !userSelected.current &&
          selected &&
          list.some((host) => host.id === selected)
        ) {
          actions.selectHost(selected);
          setPane("threads");
        }
      })
      .catch(() => {
        if (active)
          setStorageError(
            "Saved Fleet preferences could not be read. Retry after restarting the app.",
          );
      })
      .finally(() => {
        if (active) setLoaded(true);
      });
    return () => {
      active = false;
    };
  }, [session, actions]);
  useEffect(() => {
    let active = true;
    void Promise.all(
      hosts
        .filter((host) => host.id !== fixtureId)
        .map(async (host) => {
          try {
            return [host.id, await transport.pairingStatus(host.id)] as const;
          } catch {
            return [host.id, "invalid"] as const;
          }
        }),
    ).then((values) => {
      if (active) setPairings(Object.fromEntries(values));
    });
    return () => {
      active = false;
    };
  }, [hosts, s.host, s.status, pairState, saving]);
  useEffect(() => {
    setModel(null);
    setEffort(null);
  }, [s.host, s.workspace]);
  useEffect(() => {
    if (pane !== "rooms" || !s.room || !connected) return;
    // Room posts are deliberate model communication. Poll only the open pane;
    // never infer a post from a completed Turn or replay an unknown mutation.
    const timer = setInterval(() => {
      void session.refreshRoom();
    }, 4_000);
    return () => clearInterval(timer);
  }, [pane, s.room, connected, session]);

  function selectHost(id: string) {
    userSelected.current = true;
    actions.selectHost(id);
    setPane("threads");
    void savePreference(id).catch(() =>
      setStorageError(
        "Connected selection changed, but the default device could not be saved.",
      ),
    );
  }
  function savePreference(id: string | null) {
    const saved = preferenceWrites.current
      .catch(() => {})
      .then(() =>
        id
          ? SecureStore.setItemAsync(FLEET_PREFERENCE_KEY, id)
          : SecureStore.deleteItemAsync(FLEET_PREFERENCE_KEY),
      );
    preferenceWrites.current = saved;
    return saved;
  }
  async function mutateFleet(action: () => Promise<void>) {
    if (fleetBusy.current || !loaded) return;
    fleetBusy.current = true;
    setSaving(true);
    setStorageError(null);
    try {
      await action();
    } catch (error) {
      setStorageError(String(error));
    } finally {
      fleetBusy.current = false;
      setSaving(false);
    }
  }
  async function persistHosts(next: Host[]) {
    await SecureStore.setItemAsync(
      FLEET_ADDRESSES_KEY,
      saveHosts(next, [fixtureId]),
    );
    replaceHosts(next);
  }
  function addHost() {
    void mutateFleet(async () => {
      const host = makeHost({ id: hostId, endpoint: address, name: hostName });
      if (hostsRef.current.some((value) => value.id === host.id))
        throw Error(
          "This Host ID is already in Fleet. Select it to connect or pair.",
        );
      if (
        hostsRef.current.filter((value) => value.id !== fixtureId).length >=
        MAX_REMOTE_HOSTS
      )
        throw Error(
          "Fleet supports up to 10 remote devices. Remove an unused address first.",
        );
      await persistHosts([...hostsRef.current, host]);
      setAddress("");
      setHostId("");
      setHostName("");
      actions.selectHost(host.id);
      userSelected.current = true;
      await savePreference(host.id);
    });
  }
  function renameHost(id: string) {
    void mutateFleet(async () => {
      const existing = hostsRef.current.find((host) => host.id === id);
      if (!existing) return;
      const renamed = makeHost({ ...existing, name: editedName });
      await persistHosts(
        hostsRef.current.map((host) => (host.id === id ? renamed : host)),
      );
      setEditing(null);
    });
  }
  function forgetHost(host: Host, remove: boolean) {
    Alert.alert(
      remove ? `Remove ${host.name}?` : `Forget pairing for ${host.name}?`,
      remove
        ? "Remove this address and its saved pairing from this phone. Existing threads keep running on the device. This does not revoke access on the Host; use its Fleet hosting screen for that."
        : "Delete this phone's saved device credential. You'll need a fresh pairing code to connect again. Existing threads keep running; this does not revoke the Host-side grant.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: remove ? "Remove and forget" : "Forget pairing",
          style: "destructive",
          onPress: () => {
            void mutateFleet(async () => {
              const selected = session.get().host === host.id;
              if (selected) actions.selectHost(null);
              await transport.forget(host.id);
              if (remove) {
                await persistHosts(
                  hostsRef.current.filter((value) => value.id !== host.id),
                );
                if (selected) await savePreference(null);
              } else if (selected) actions.selectHost(host.id);
              setPairings((previous) => ({
                ...previous,
                [host.id]: "unpaired",
              }));
            });
          },
        },
      ],
    );
  }
  async function pair() {
    if (pairingBusy.current || !pairCode.trim() || saving) return;
    pairingBusy.current = true;
    setPairing(true);
    try {
      await actions.pair();
    } finally {
      pairingBusy.current = false;
      setPairing(false);
    }
  }
  const button = (
    label: string,
    action: () => void,
    disabled = false,
    secondary = false,
  ) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={action}
      style={[
        styles.button,
        secondary && styles.secondaryButton,
        disabled && styles.disabled,
      ]}
    >
      <Text
        style={[styles.buttonText, secondary && styles.secondaryButtonText]}
      >
        {label}
      </Text>
    </Pressable>
  );
  const target = selectedHost
    ? `${selectedHost.name}${selectedWorkspace ? ` / ${selectedWorkspace.name}` : ""}`
    : "No device selected";
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <Text style={styles.overline}>ZENX / FLEET</Text>
        <Text style={styles.title}>Your devices. One conversation.</Text>
        <Text style={styles.meta}>
          Continue on a trusted device. Threads and execution stay on that Host.
        </Text>
        <View style={styles.controls}>
          {button("Fleet", () => setPane("fleet"), false, pane !== "fleet")}
          {button(
            "Threads",
            () => setPane("threads"),
            false,
            pane !== "threads",
          )}
          {button("PAW", () => setPane("rooms"), false, pane !== "rooms")}
        </View>
        <View style={styles.target}>
          <Text style={styles.name}>Target: {target}</Text>
          <Text style={styles.meta}>
            {selectedHost
              ? deviceStatus({
                  fixture: isFixture,
                  selected: true,
                  connection: s.status,
                  pairing: pairings[selectedHost.id],
                })
              : "Add or choose a device in Fleet"}
          </Text>
          {reconnectAvailable({
            host: s.host,
            connection: s.status,
            command: s.command,
            pairing: s.host ? pairings[s.host] : undefined,
          }) &&
            button(
              "Reconnect and read device",
              () => {
                void actions.reconnect();
              },
              saving || pairing,
            )}
        </View>
        {s.error && (
          <Text accessibilityRole="alert" style={styles.error}>
            {s.error}
          </Text>
        )}
        {storageError && (
          <Text accessibilityRole="alert" style={styles.error}>
            {storageError}
          </Text>
        )}
        {pane === "fleet" && (
          <>
            <Text style={styles.heading}>Devices</Text>
            {!loaded && <Text style={styles.meta}>Loading saved devices…</Text>}
            {hosts.map((host) => (
              <View key={host.id} style={styles.card}>
                <Text style={styles.name}>{host.name}</Text>
                <Text style={styles.meta}>{host.endpoint}</Text>
                <Text style={styles.meta}>
                  {deviceStatus({
                    fixture: host.id === fixtureId,
                    selected: s.host === host.id,
                    connection: s.status,
                    pairing: pairings[host.id],
                  })}
                </Text>
                <View style={styles.controls}>
                  {button(
                    s.host === host.id
                      ? "Open selected device"
                      : host.id === fixtureId
                        ? "Explore demo"
                        : "Connect device",
                    () => selectHost(host.id),
                    saving || pairing || !loaded,
                  )}
                  {host.id !== fixtureId &&
                    button(
                      "Rename",
                      () => {
                        setEditing(host.id);
                        setEditedName(host.name);
                      },
                      saving,
                      true,
                    )}
                </View>
                {editing === host.id && (
                  <>
                    <TextInput
                      style={styles.input}
                      value={editedName}
                      onChangeText={setEditedName}
                      accessibilityLabel={`Name for ${host.name}`}
                      maxLength={80}
                    />
                    <View style={styles.controls}>
                      {button(
                        "Save device name",
                        () => renameHost(host.id),
                        saving || !editedName.trim(),
                      )}
                      {button(
                        "Cancel rename",
                        () => setEditing(null),
                        saving,
                        true,
                      )}
                    </View>
                  </>
                )}
                {host.id !== fixtureId && (
                  <View style={styles.controls}>
                    {button(
                      "Forget pairing",
                      () => forgetHost(host, false),
                      saving || pairing || pairings[host.id] === "unpaired",
                      true,
                    )}
                    {button(
                      "Remove device",
                      () => forgetHost(host, true),
                      saving || pairing,
                      true,
                    )}
                  </View>
                )}
              </View>
            ))}
            {selectedHost && !isFixture && (
              <View style={styles.card}>
                <Text style={styles.name}>Pair {selectedHost.name}</Text>
                <Text style={styles.meta}>
                  Open Fleet hosting on this device. Enter its fresh one-use
                  code. TLS must be trusted by Android; secrets are kept in
                  SecureStore.
                </Text>
                <TextInput
                  style={styles.input}
                  placeholder="Pairing code"
                  placeholderTextColor={colors.muted}
                  value={pairCode}
                  onChangeText={updatePairCode}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  accessibilityLabel="Pairing code"
                />
                {button(
                  pairing ? "Pairing…" : "Pair selected device",
                  () => {
                    void pair();
                  },
                  pairing || saving || !pairCode.trim(),
                )}
                {pairState && <Text style={styles.meta}>{pairState}</Text>}
              </View>
            )}
            <Text style={styles.heading}>Add a device</Text>
            <Text style={styles.meta}>
              Use the Host ID and HTTPS address shown in the device's Fleet
              hosting screen. Adding an address does not pair it.
            </Text>
            <TextInput
              style={styles.input}
              placeholder="Device name, e.g. Studio desktop"
              placeholderTextColor={colors.muted}
              value={hostName}
              onChangeText={setHostName}
              accessibilityLabel="New device name"
              maxLength={80}
            />
            <TextInput
              style={styles.input}
              placeholder="https://desktop.example:443"
              placeholderTextColor={colors.muted}
              value={address}
              onChangeText={setAddress}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              accessibilityLabel="Host HTTPS origin"
            />
            <TextInput
              style={styles.input}
              placeholder="Host ID"
              placeholderTextColor={colors.muted}
              value={hostId}
              onChangeText={setHostId}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Host ID"
            />
            {button(
              saving ? "Saving…" : "Add device address",
              addHost,
              saving || pairing || !loaded || !address.trim() || !hostId.trim(),
            )}
            <Text style={styles.meta}>
              Demo is fixture-only. It cannot send, run tools, pair or create
              real threads.
            </Text>
          </>
        )}
        {pane !== "fleet" && (
          <>
            <Text style={styles.heading}>Workspace</Text>
            {!s.host &&
              button("Choose device in Fleet", () => setPane("fleet"))}
            {s.host && !connected && (
              <Text style={styles.meta}>
                Connect or pair this device in Fleet to view its workspaces.
              </Text>
            )}
            <View style={styles.controls}>
              {s.workspaces.map((workspace) => (
                <React.Fragment key={workspace.id}>
                  {button(
                    workspace.name,
                    () => actions.selectWorkspace(workspace.id),
                    !connected,
                    s.workspace !== workspace.id,
                  )}
                </React.Fragment>
              ))}
            </View>
            {!s.workspace && connected && (
              <Text style={styles.meta}>Choose a workspace to continue.</Text>
            )}
          </>
        )}
        {pane === "threads" && s.workspace && (
          <>
            <Text style={styles.heading}>Threads on {selectedHost?.name}</Text>
            <Text style={styles.meta}>
              Remote commands use this device and workspace. Tools and approvals
              stay on the Host; Full Access threads cannot start remotely.
            </Text>
            {s.threads.map((thread) => (
              <View
                key={thread.id}
                style={[
                  styles.card,
                  s.thread === thread.id && styles.selectedCard,
                ]}
              >
                <Text style={styles.name}>{thread.title}</Text>
                <Text style={styles.meta}>{thread.status}</Text>
                {button(
                  s.thread === thread.id ? "Refresh thread" : "Open thread",
                  () => actions.openThread(thread.id),
                  !connected,
                  true,
                )}
              </View>
            ))}
            {!s.threads.length && connected && (
              <Text style={styles.meta}>
                No remote-visible threads in this workspace.
              </Text>
            )}
            {s.models?.length > 0 && (
              <View style={styles.card}>
                <Text style={styles.name}>New thread model</Text>
                <View style={styles.controls}>
                  {button(
                    "Host default",
                    () => {
                      setModel(null);
                      setEffort(null);
                    },
                    false,
                    model !== null,
                  )}
                  {s.models.map((option) => (
                    <React.Fragment key={option.id}>
                      {button(
                        option.displayName,
                        () => {
                          setModel(option.id);
                          setEffort(null);
                        },
                        false,
                        model !== option.id,
                      )}
                    </React.Fragment>
                  ))}
                </View>
                {model && (
                  <View style={styles.controls}>
                    {button(
                      "Default effort",
                      () => setEffort(null),
                      false,
                      effort !== null,
                    )}
                    {s.models
                      .find((option) => option.id === model)
                      ?.supportedReasoningEfforts.map((option) => (
                        <React.Fragment key={option.reasoningEffort}>
                          {button(
                            option.reasoningEffort,
                            () => setEffort(option.reasoningEffort),
                            false,
                            effort !== option.reasoningEffort,
                          )}
                        </React.Fragment>
                      ))}
                  </View>
                )}
              </View>
            )}
            {s.modelsError && <Text style={styles.error}>{s.modelsError}</Text>}
            {button(
              "New thread on this device",
              () => {
                void actions.createThread({
                  ...(model ? { model } : {}),
                  ...(effort ? { effort } : {}),
                });
              },
              blocked,
            )}
            {s.thread && (
              <>
                <Text style={styles.heading}>
                  {selectedThread?.title ?? "Conversation"}
                </Text>
                {s.items.map((item) => (
                  <View key={item.id} style={styles.card}>
                    <Text style={styles.meta}>
                      {item.role} · {item.status}
                    </Text>
                    <Text selectable style={styles.name}>
                      {item.text}
                    </Text>
                  </View>
                ))}
                {s.turns.map((turn) => (
                  <Text key={turn.id} style={styles.meta}>
                    Turn {turn.id}: {turn.status}
                  </Text>
                ))}
                <TextInput
                  style={[styles.input, styles.composer]}
                  multiline
                  placeholder={`Message ${selectedHost?.name ?? "device"}`}
                  placeholderTextColor={colors.muted}
                  value={draft}
                  onChangeText={actions.editDraft}
                  accessibilityLabel="Thread message"
                />
                <View style={styles.controls}>
                  {button(
                    "Send message",
                    () => {
                      void actions.send();
                    },
                    blocked || !draft.trim(),
                  )}
                  {button(
                    "Stop active turn",
                    () => {
                      void actions.stop();
                    },
                    blocked ||
                      !s.turns.some((turn) => turn.status === "inProgress"),
                    true,
                  )}
                </View>
              </>
            )}
          </>
        )}
        {pane === "rooms" && s.workspace && (
          <>
            <Text style={styles.heading}>
              PAW conversations on {selectedHost?.name}
            </Text>
            {!s.supportsRooms && (
              <Text style={styles.meta}>
                This device does not expose Rooms to this connection. Continue
                in Threads or enable a PAW conversation on the Host.
              </Text>
            )}
            {s.roomsError && <Text style={styles.error}>{s.roomsError}</Text>}
            {s.supportsRooms && !s.rooms.length && !s.roomsError && (
              <Text style={styles.meta}>
                No PAW conversations in this grant's workspace. Set up a PAW
                conversation on the Host.
              </Text>
            )}
            {s.rooms.map((room) => (
              <View
                key={room.id}
                style={[styles.card, s.room === room.id && styles.selectedCard]}
              >
                <Text style={styles.name}>{room.name}</Text>
                <Text style={styles.meta}>PAW thread: {room.threadId}</Text>
                {button(
                  "Open PAW",
                  () => actions.openRoom(room.id),
                  !connected,
                  true,
                )}
              </View>
            ))}
            {s.room && (
              <>
                <Text style={styles.heading}>
                  {selectedRoom?.name ?? "Room"}
                </Text>
                <Text style={styles.meta}>
                  Human messages wake or steer your PAW. Replies appear when it
                  deliberately posts to this Room.
                </Text>
                {s.roomLoading && (
                  <Text style={styles.meta}>Reading Room…</Text>
                )}
                {s.roomMessages.map((message) => (
                  <View key={message.id} style={styles.card}>
                    <Text style={styles.meta}>
                      {message.author} · {message.kind} ·{" "}
                      {new Date(message.createdAt).toLocaleString()}
                    </Text>
                    <Text selectable style={styles.name}>
                      {message.text}
                    </Text>
                  </View>
                ))}
                {button(
                  "Refresh PAW",
                  () => {
                    void session.refreshRoom();
                  },
                  !connected || s.roomLoading,
                  true,
                )}
                <TextInput
                  style={[styles.input, styles.composer]}
                  multiline
                  placeholder={`Message ${selectedRoom?.name ?? "Room"}`}
                  placeholderTextColor={colors.muted}
                  value={draft}
                  onChangeText={actions.editDraft}
                  accessibilityLabel="PAW message"
                />
                {button(
                  "Post to this PAW",
                  () => {
                    void actions.postRoom();
                  },
                  blocked || !s.roomReady || !draft.trim(),
                )}
              </>
            )}
          </>
        )}
        {s.lastRequest && pane !== "fleet" && (
          <Text style={styles.meta}>
            {s.lastRequest.kind === "room"
              ? `Room message ${s.lastRequest.messageId} saved. PAW work may be admitted asynchronously.`
              : s.lastRequest.queued
                ? "Input accepted for the next model cycle. Follow the Host's canonical Turn events."
                : `${s.lastRequest.kind === "stop" ? "Stop request" : "Message"} accepted for Turn ${s.lastRequest.turnId}. Admission is not completion.`}
          </Text>
        )}
        {s.command === "pending" && pane !== "fleet" && (
          <Text style={styles.meta}>Waiting for this device's receipt…</Text>
        )}
        {s.command === "uncertain" && (
          <Text style={styles.error}>
            Delivery unknown. Reconnect and inspect this device's canonical
            history before sending again. Nothing is automatically replayed.
          </Text>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, paddingBottom: 72, gap: 12 },
  overline: {
    color: colors.accent,
    fontWeight: "700",
    letterSpacing: 3,
    marginTop: 16,
  },
  title: {
    color: colors.text,
    fontSize: 30,
    fontWeight: "700",
    marginBottom: 8,
  },
  heading: {
    color: colors.text,
    fontSize: 21,
    fontWeight: "700",
    marginTop: 20,
  },
  target: {
    borderColor: colors.accent,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 8,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  selectedCard: { borderColor: colors.accent, borderWidth: 1 },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  name: { color: colors.text, fontSize: 16, lineHeight: 23 },
  meta: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  error: { color: colors.warn, padding: 12, lineHeight: 20 },
  input: {
    backgroundColor: colors.card,
    borderColor: colors.muted,
    borderWidth: 1,
    color: colors.text,
    borderRadius: 12,
    padding: 14,
    minHeight: 50,
  },
  composer: { minHeight: 90, textAlignVertical: "top" },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
  },
  secondaryButton: {
    backgroundColor: colors.card,
    borderColor: colors.muted,
    borderWidth: 1,
  },
  buttonText: { color: colors.bg, fontWeight: "700" },
  secondaryButtonText: { color: colors.text },
  disabled: { opacity: 0.4 },
});
