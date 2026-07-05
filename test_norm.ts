import { normRepairPath } from "./src/core/projectRepair";
import { normGatePath } from "./src/core/projectGate";

const paths = [
  'src/app/create_order.py',
  'src/app.py',
  './src/app.py',
  '/src/app.py',
  'src/app/',
  '/src/app/',
  'src//app.py',
  './src//app.py',
  '//src/app.py',
];

console.log('Path | normGatePath | normRepairPath | Match?');
for (const p of paths) {
  const gate = normGatePath(p);
  const repair = normRepairPath(p);
  const match = gate === repair ? 'YES' : 'NO!!!';
  console.log(`"${p}" | "${gate}" | "${repair}" | ${match}`);
}
