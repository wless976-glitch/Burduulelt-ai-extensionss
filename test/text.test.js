import { describe, it, expect } from "vitest";
import { latin, requestKey, isDocRequest } from "../extension/text.js";

describe("latin()", () => {
  it("кирилл, латин бичвэрийг нэг хэлбэрт буулгана", () => {
    expect(latin("Бүрдүүлэх")).toBe("burduuleh");
    expect(latin("bvrdvvleh")).toBe("burduuleh");
    expect(latin("Хүсэлт")).toBe(latin("huselt"));
  });
});

describe("requestKey()", () => {
  it("үгийн дараалал, нөхцөлийн дагавар, цэг таслалаас үл хамаарна", () => {
    expect(requestKey("Компани байгуулах бичиг баримт бүрдүүл.")).toBe(requestKey("компани байгуулахад бичиг баримт бүрдүүлэх"));
    expect(requestKey("Компани байгуулах")).toBe(requestKey("nadad company baiguulahad heregtei bichig barimt burduulj ug"));
  });

  it("зөвхөн ерөнхий үгтэй бол бүх үгийг ашиглана", () => {
    expect(requestKey("бичиг баримт")).not.toBe("");
  });
});

describe("isDocRequest()", () => {
  it.each([
    "Компани байгуулах бичиг баримт бүрдүүл",
    "nadad company baiguulahad heregtei bichig barimt burduulj ug",
    "Солонгос руу жуулчны виз мэдүүлэх",
    "Ямар лавлагаа хэрэгтэй вэ",
  ])("бичиг баримтын хүсэлт: %s", q => expect(isDocRequest(q)).toBe(true));

  it.each(["НДШ хэдэн сар төлөгдсөн бэ?", "Зээлийн үлдэгдэл хэд вэ?", ""])("энгийн асуулт: %s", q => expect(isDocRequest(q)).toBe(false));
});
