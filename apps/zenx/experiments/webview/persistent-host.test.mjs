import assert from "node:assert/strict";
import test from "node:test";
import { PersistentGuestHost } from "./persistent-host.mjs";

test("switching tabs and closing panels retains the exact elements; close is explicit", () => {
  const children = [];
  const create = () => ({
    dataset: {},
    style: {},
    attributes: {},
    setAttribute(k, v) {
      this.attributes[k] = v;
    },
    remove() {
      children.splice(children.indexOf(this), 1);
    },
  });
  const host = new PersistentGuestHost(
    { append: (guest) => children.push(guest) },
    create,
  );
  const a = host.add("a", "http://fixture/a", "synthetic");
  const b = host.add("b", "http://fixture/b", "synthetic");
  host.show("a");
  assert.equal(a.style.visibility, "visible");
  for (let i = 0; i < 10; i++) {
    host.show("b");
    host.show(undefined);
    host.show("a");
  }
  assert.deepEqual(children, [a, b]);
  assert.equal(b.style.visibility, "hidden");
  assert.equal(b.style.pointerEvents, "none");
  assert.throws(() => host.add("a", "", ""), /Duplicate/);
  assert.throws(() => host.show("missing"), /Unknown/);
  assert.equal(a.style.visibility, "visible");
  host.close("a");
  assert.deepEqual(children, [b]);
});
