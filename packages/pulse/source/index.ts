import {} from "json-joy/lib/json-crdt-patch";
import { createPulse } from "./pulses/Pulse";
import { definePulse } from "./pulses/PulseDefinition";

console.log("------PULSES-------");

type ItemList = {
	id: string;
	kind: "ItemList";
	items: Array<number>;
};

const ItemList = definePulse<ItemList>("ItemList").bind();
const pulse = createPulse(ItemList, {
	items: [1, 2, 3],
});

console.log(pulse);

// console.log("------PRIMITIVE-------");

// const model = Model.create();
// console.log(model.toString());

// const str = s.con("Hello world");

// model.api.set({ items: [{ x: 12 }, { x: 312 }] });
// console.log(model.toString());

// model.api.arr(["items"]).get(1).asObj().set({ x: 424 });
// console.log(model.toString());

// console.log({ model });

// model.api.str();
// console.log(model.toString());

// model.api.val().set({ x: "za", toto: null, ahah: [11, 24] });
// console.log(model.toString());

// console.log("------SIMPLE OBJECT-------")
// const schema = s.obj({
// 	text: s.con("hello"),
// });

// const model = Model.create(schema);

// model.onbeforepatch = (patch) => {
// 	console.log("BEFOREPATCH", patch);
// };

// model.onpatch = (patch) => {
// 	console.log("PATCH", patch);
// };

// model.api.obj().onChildChange((event) => {
// 	console.log("CHILDCHANGE", event);
// });

// console.log(model, model.toString());

// model.api.obj([]).set({ text: "HEYYY" });
// model.api.obj([]).set({ text: 123 });

// console.log(model, model.toString());

// const patches = model.api.flush();

// console.log("flushed:", patches);
