import * as cheerio from "cheerio";

export interface ContactCard {
  office: string;
  description: string;
  email: string | null;
}

export interface ContactData {
  title: string;
  contacts: ContactCard[];
}

export function parseContact(html: string): ContactData {
  const $ = cheerio.load(html);
  const result: ContactData = {
    title: $("strong.fw-bold.h2").first().text().trim(),
    contacts: [],
  };

  $(".card.rounded-3.shadow").each((_, card) => {
    const $card = $(card);
    const office = $card.find(".card-header strong").text().trim();
    const descEl = $card.find(".card-body p").first();
    const emailEl = $card.find(".card-body p.text-success");
    const description = descEl.text().trim();
    const email = emailEl.length ? emailEl.text().trim() : null;
    if (office) {
      result.contacts.push({ office, description, email });
    }
  });

  return result;
}
