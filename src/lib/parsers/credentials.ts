import * as cheerio from "cheerio";

export interface CredentialRow {
  account: string;
  username: string;
  defaultCredentials: string;
  url: string | null;
  venueDate: string;
  seatLocation: string;
}

export interface RankInfo {
  name: string;
  rank: string;
}

export interface CredentialsData {
  title: string;
  credentials: CredentialRow[];
  ranks: RankInfo[];
}

export function parseCredentials(html: string): CredentialsData {
  const $ = cheerio.load(html);
  const result: CredentialsData = {
    title: $("h3.box-title b").first().text().trim(),
    credentials: [],
    ranks: [],
  };

  $("table.customTable").each((tableIdx, table) => {
    const $table = $(table);
    const headers: string[] = [];
    $table.find("tr.tableHeader td").each((_, cell) => {
      headers.push($(cell).text().trim());
    });

    if (headers.includes("Account")) {
      $table.find("tr.tableContent").each((_, row) => {
        const cells = $(row).find("td");
        result.credentials.push({
          account: $(cells[0]).text().trim(),
          username: $(cells[1]).text().trim(),
          defaultCredentials: $(cells[2]).text().trim(),
          url: $(cells[3]).find("a").attr("href") || $(cells[3]).text().trim() || null,
          venueDate: $(cells[4]).text().trim(),
          seatLocation: $(cells[5])?.text().trim() || "",
        });
      });
    } else if (headers.includes("Name")) {
      $table.find("tr").each((_, row) => {
        const cells = $(row).find("td");
        if (cells.length >= 2 && !$(row).hasClass("tableHeader")) {
          result.ranks.push({
            name: $(cells[0]).text().trim(),
            rank: $(cells[1]).text().trim(),
          });
        }
      });
    }
  });

  return result;
}
