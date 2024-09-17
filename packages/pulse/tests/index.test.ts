import { PulseArray } from "pulse/source"

const list = new PulseArray<number>([])

// list.push(7, 9, 5)

// console.log(list.value, list.state)

list.unshift(1, 3, 2)

console.log(list.value, list.state)

list.insert(1, [2, 3])

console.log(list.value, list.state)
