//! Types used by the io-ts runtime tests in app/langs/io-ts/typecheck.

#[typeshare]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: ItemId,
    pub count: u8,
    pub icon: Option<String>,
    #[serde(default)]
    pub pinned: bool,
    pub cleared: Option<Option<String>>,
    pub kind: Kind,
    pub tags: Vec<String>,
    pub by_index: HashMap<u32, Kind>,
    pub by_kind: HashMap<Kind, String>,
    pub children: Vec<Item>,
    pub point: [i32; 2],
    pub nothing: (),
    #[serde(rename = "kebab-key")]
    pub kebab: String,
    pub page: Page<Kind>,
    pub action: Action,
    pub bytes: [u8; 6],
    pub empty: [u8; 0],
    pub letter: char,
    pub by_letter: HashMap<char, u8>,
    pub pages: HashMap<String, Page<Kind>>,
    // A key codec that changes keys, so one can turn into __proto__ after decoding
    #[typeshare(
        typescript(type = "Record<string, number>"),
        io_ts(type = "record(new t.Type<string>(\"lowercase\", t.string.is, (u, c) => (typeof u === \"string\" ? t.success(u.toLowerCase()) : t.failure(u, c)), t.identity), t.number)")
    )]
    pub lowercased: HashMap<String, u32>,
    #[typeshare(typescript(type = "string"), io_ts(type = "t.string"))]
    pub label: Option<String>,
    pub child: Option<Page<Kind>>,
    pub constructor: Option<String>,
    #[serde(default)]
    pub fallback: Option<Option<Page<Kind>>>,
    #[serde(default)]
    pub to_string: bool,
    pub nothing_twice: Option<Option<()>>,
}

#[typeshare]
pub struct LiteralA {
    #[typeshare(typescript(type = "\"a\""), io_ts(type = "t.literal(\"a\")"))]
    pub kind: Option<String>,
}

#[typeshare]
pub struct LiteralB {
    #[typeshare(typescript(type = "\"b\""), io_ts(type = "t.literal(\"b\")"))]
    pub kind: Option<String>,
}

#[typeshare]
pub type Block = [u8; 1024];

#[typeshare]
pub type LargeBlock = [u8; 16384];

#[typeshare]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Login,
    CreditCard,
}

#[typeshare]
#[serde(tag = "type", content = "content", rename_all = "camelCase")]
pub enum Action {
    Lock,
    Open(String),
    MaybeOpen(Option<String>),
    Move { from: u16, to: Option<u16> },
    Nested(Box<Action>),
}

#[typeshare]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next: Option<String>,
}

#[typeshare]
pub type ItemId = String;
