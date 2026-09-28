import React, { useEffect, useMemo, useRef, useState } from "react";
import * as SecureStore from "expo-secure-store";
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  TextInput,
  Pressable,
  StyleSheet,
} from "react-native";
import { StatusBar } from "expo-status-bar";
import { createSession } from "./session.mjs";
import { fixtureHosts } from "./fixture.mjs";
import { combinedTransport, setHostList, transport } from "./transport";

type ScreenState = ReturnType<ReturnType<typeof createSession>["get"]>;
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
  const [draft, setDraft] = useState("");
  const [address, setAddress] = useState("");
  const [hostId, setHostId] = useState("");
  const [pairCode, setPairCode] = useState("");
  const [pairState, setPairState] = useState<string | null>(null);
  const [hosts, setHosts] = useState(fixtureHosts);
  const [storageError, setStorageError] = useState<string | null>(null);
  const userSelected = useRef(false);
  const session = useMemo(
    () => createSession(combinedTransport, setScreen),
    [],
  );
  useEffect(() => {
    setHostList(hosts);
    session.setHosts(hosts);
  }, [session, hosts]);
  useEffect(() => () => session.dispose(), [session]);
  useEffect(() => {
    let active = true;
    Promise.all([
      SecureStore.getItemAsync("zenx-mobile-host-preference-v1"),
      SecureStore.getItemAsync("zenx-mobile-addresses-v1"),
    ])
      .then(([selected, saved]) => {
        if (!active) return;
        const addresses: { id: string; endpoint: string }[] = saved
          ? JSON.parse(saved)
          : [];
        const valid = addresses
          .filter(
            (value) =>
              typeof value?.id === "string" &&
              typeof value?.endpoint === "string" &&
              /^https:\/\/[^\s/]+(?::\d+)?\/?$/.test(value.endpoint),
          )
          .slice(0, 10);
        const list = [
          ...fixtureHosts,
          ...valid.map((value) => ({ ...value, name: value.id })),
        ];
        setHostList(list);
        setHosts(list);
        if (
          !userSelected.current &&
          selected &&
          list.some((h) => h.id === selected)
        )
          session.selectHost(selected);
      })
      .catch((e) => {
        if (active)
          setStorageError(`Device preference unavailable: ${String(e)}`);
      });
    return () => {
      active = false;
    };
  }, [session]);
  const s = screen ?? session.get();
  function selectHost(id: string) {
    userSelected.current = true;
    session.selectHost(id);
    void SecureStore.setItemAsync("zenx-mobile-host-preference-v1", id).catch(
      (e) => setStorageError(`Could not save device preference: ${String(e)}`),
    );
  }
  function addHost() {
    // An address is never interpreted as an authenticated connection by the fixture.
    const value = address.trim();
    const id = hostId.trim();
    if (
      !/^https:\/\/[^\s/]+(?::\d+)?\/?$/.test(value) ||
      !/^[a-zA-Z0-9-]{8,80}$/.test(id)
    ) {
      setStorageError("Enter HTTPS origin and Host ID from the Host operator.");
      return;
    }
    if (hosts.some((host) => host.id === id) || hosts.length > 10) return;
    const addresses = [
      ...hosts
        .filter((host) => host.id !== fixtureHosts[0].id)
        .map((host) => ({ id: host.id, endpoint: host.endpoint })),
      { id, endpoint: value },
    ];
    setHosts([...hosts, { id, name: id, endpoint: value }]);
    void SecureStore.setItemAsync(
      "zenx-mobile-addresses-v1",
      JSON.stringify(addresses),
    ).catch((e) => setStorageError(`Could not save address: ${String(e)}`));
    setAddress("");
    setHostId("");
  }
  const button = (label: string, action: () => void, disabled = false) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={action}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
  return (
    <SafeAreaView style={styles.root}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.overline}>ZENX / ANDROID</Text>
        <Text style={styles.title}>Your desktop, within reach.</Text>
        <Text style={styles.banner}>
          Demo desktop is a fixture only. Real hosts require verified TLS, a
          fresh pairing code, and a separate isolated CLI Host. No tool/approval
          transcript is exposed.
        </Text>
        <Text style={styles.heading}>Primary device</Text>
        {s.hosts.map((h) => (
          <View key={h.id} style={styles.card}>
            <Text style={styles.name}>{h.name}</Text>
            <Text style={styles.meta}>
              {h.endpoint} ·{" "}
              {s.host === h.id
                ? h.id === fixtureHosts[0].id
                  ? `fixture · ${s.status}`
                  : s.status
                : "not selected"}
            </Text>
            {button(s.host === h.id ? "Selected" : "Select device", () =>
              selectHost(h.id),
            )}
          </View>
        ))}
        <TextInput
          style={styles.input}
          placeholder="https://host.example (not paired)"
          placeholderTextColor={colors.muted}
          value={address}
          onChangeText={setAddress}
          autoCapitalize="none"
          accessibilityLabel="Host address"
        />
        <TextInput
          style={styles.input}
          placeholder="Host ID from desktop"
          placeholderTextColor={colors.muted}
          value={hostId}
          onChangeText={setHostId}
          autoCapitalize="none"
          accessibilityLabel="Host ID"
        />
        {button("Add address (unpaired)", addHost)}
        {s.host && s.host !== fixtureHosts[0].id && (
          <>
            <TextInput
              style={styles.input}
              placeholder="Fresh pairing code"
              placeholderTextColor={colors.muted}
              value={pairCode}
              onChangeText={setPairCode}
              autoCapitalize="none"
              secureTextEntry
              accessibilityLabel="Pairing code"
            />
            {button("Pair selected Host", () => {
              const selected = s.host!;
              void transport
                .pair(selected, pairCode)
                .then(() => {
                  setPairCode("");
                  setPairState("Paired. Select Host again to connect.");
                  if (session.get().host === selected)
                    session.selectHost(selected);
                })
                .catch((e) => setPairState(String(e)));
            })}
            {pairState && <Text style={styles.meta}>{pairState}</Text>}
          </>
        )}
        {s.error && <Text style={styles.error}>{s.error}</Text>}
        {storageError && <Text style={styles.error}>{storageError}</Text>}
        <Text style={styles.heading}>Workspace</Text>
        {!s.host && <Text style={styles.meta}>Select a device first.</Text>}
        {s.workspaces.map((w) => (
          <View key={w.id} style={styles.row}>
            <Text style={styles.name}>{w.name}</Text>
            {button(
              s.workspace === w.id ? "Selected workspace" : "Switch workspace",
              () => session.selectWorkspace(w.id),
            )}
          </View>
        ))}
        <Text style={styles.heading}>Threads</Text>
        {s.workspace && s.host !== fixtureHosts[0].id && (
          <Text style={styles.banner}>
            Remote threads are read-only + approval-required. This client cannot
            approve tools or access tool outputs. Full Access threads cannot be
            started remotely.
          </Text>
        )}
        {!s.workspace && (
          <Text style={styles.meta}>
            Choose a workspace to view its threads.
          </Text>
        )}
        {s.workspace &&
          s.threads.map((t) => (
            <View key={t.id} style={styles.card}>
              <Text style={styles.name}>{t.title}</Text>
              <Text style={styles.meta}>{t.status}</Text>
              {button("Open thread", () => session.openThread(t.id))}
            </View>
          ))}
        {s.thread && (
          <>
            <Text style={styles.heading}>Conversation</Text>
            {s.items.map((item) => (
              <View key={item.id} style={styles.card}>
                <Text style={styles.meta}>
                  {item.role} · {item.status}
                </Text>
                <Text style={styles.name}>{item.text}</Text>
              </View>
            ))}
            <TextInput
              style={styles.input}
              multiline
              placeholder="Message"
              placeholderTextColor={colors.muted}
              value={draft}
              onChangeText={setDraft}
            />
            {button(
              "Send message",
              () => {
                void session.command("send", {
                  threadId: s.thread,
                  text: draft,
                });
              },
              !draft.trim() || s.command === "pending",
            )}
            {button(
              "Stop current turn",
              () => {
                void session.command("stop", { threadId: s.thread });
              },
              s.command === "pending",
            )}
          </>
        )}
        {s.workspace &&
          button(
            "New thread",
            () => {
              void session.command("create", {});
            },
            s.command === "pending",
          )}
        {s.command && <Text style={styles.meta}>Command: {s.command}</Text>}
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
    fontSize: 32,
    fontWeight: "700",
    marginBottom: 8,
  },
  banner: {
    color: colors.warn,
    borderColor: colors.warn,
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    lineHeight: 21,
  },
  heading: {
    color: colors.text,
    fontSize: 21,
    fontWeight: "700",
    marginTop: 20,
  },
  card: {
    backgroundColor: colors.card,
    borderRadius: 16,
    padding: 16,
    gap: 10,
  },
  row: { backgroundColor: colors.card, borderRadius: 12, padding: 14, gap: 8 },
  name: { color: colors.text, fontSize: 16 },
  meta: { color: colors.muted, fontSize: 13 },
  error: { color: colors.warn, padding: 12 },
  input: {
    backgroundColor: colors.card,
    color: colors.text,
    borderRadius: 12,
    padding: 14,
    minHeight: 50,
  },
  button: {
    backgroundColor: colors.accent,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    alignSelf: "flex-start",
  },
  buttonText: { color: colors.bg, fontWeight: "700" },
  disabled: { opacity: 0.4 },
});
