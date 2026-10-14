// Монгол хүсэлтийн текст боловсруулах: кирилл/латин бичвэрийг нэгтгэх, хүсэлтийн түлхүүр, бичиг баримтын хүсэлт таних.
// DOM, chrome API ашигладаггүй тул тестлэхэд хялбар.

// Кирилл болон латинаар бичсэн монгол хүсэлтийг нэг латин хэлбэрт буулгана: «Компани байгуулах бичиг баримт бүрдүүл» ба
// «nadad company baiguulahad heregtei bichig barimt burduulj ug» ижил үгсээр танигдана.
// ү/у → u, ө/о → o (латинаар ялгаж бичдэггүй), v/w → u («bvrdvvl»), q → o, kh → h, c → ts («cugluul»), «co» → ko («company»).
const CYR = { а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "yo", ж: "j", з: "z", и: "i", й: "i", к: "k", л: "l", м: "m", н: "n", о: "o", ө: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ү: "u", ф: "f", х: "h", ц: "ts", ч: "ch", ш: "sh", щ: "sh", ъ: "", ы: "ii", ь: "i", э: "e", ю: "yu", я: "ya" };
export const latin = s => String(s).toLowerCase().replace(/[а-яёөү]/g, c => CYR[c] ?? c)
  .replace(/kh/g, "h").replace(/co/g, "ko").replace(/c(?!h)/g, "ts").replace(/[vw]/g, "u").replace(/q/g, "o");

// Хүсэлтийн түлхүүр: «Компани байгуулах бичиг баримт бүрдүүл.» = «компани байгуулахад бичиг баримт бүрдүүлэх» = латин бичвэр.
// Ерөнхий үгсийг хасаж, үг бүрийн эхний 4 үсгээр (нөхцөлийн дагавар үл хамаарч), дарааллаас үл хамааран тааруулна.
const FILLER = /^(burd|bichig|barimt|material|jagsaa|shaard|heregt|beld|garga|nadad|minii|yamar|ymar|yuu?$|ue$|be$|uu$|(og|ug)\S{0,4}$)/;
export function requestKey(s) {
  const all = latin(s).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
  const words = all.filter(w => !FILLER.test(w));
  return [...new Set((words.length ? words : all).map(w => w.slice(0, 4)))].sort().join(" ");
}

// Бичиг баримт бүрдүүлэх хүсэлтийг AI-аас хамааралгүйгээр танина: ийм хүсэлт бүрт жагсаалт заавал гарна
// (AI-д ангилуулахад заримдаа энгийн хариулт гарч байсан, жишээ нь «Компани байгуулах бичиг баримт бүрдүүл»).
// latin()-аар буулгасан бичвэр дээр шалгана: «лавлагаа» → laulagaa, «виз» → uiz, «мэдүүл» → meduul.
const DOC_REQUEST = new RegExp([
  "burdu*l", // бүрдүүл, burduul, bvrdvvl
  "material",
  "(bichig\\s*barimt|laulagaa)\\S*\\s+(\\S+\\s+)?(heregt|shaard|beld|tsugluul|garga|jagsaa)", // бичиг баримт (нь) хэрэгтэй, …-ын жагсаалт
  "(heregt|shaard)\\S*\\s+(bichig\\s*barimt|laulagaa|material)", // хэрэгтэй бичиг баримт
  "\\b(yamar|ymar)\\s+(bichig\\s*barimt|laulagaa|material)",
  "\\byuu?\\s+yuu?\\s+(heregt|shaard|beld)", // юу юу хэрэгтэй
  "\\bui[zs]\\S*\\s+(\\S+\\s+)?(meduul|husel|auah)", // виз мэдүүлэх, visa avahad
].join("|"));
export const isDocRequest = s => DOC_REQUEST.test(latin(s));
