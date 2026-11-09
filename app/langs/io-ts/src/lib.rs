/*!
Code generation for [io-ts](https://github.com/gcanti/io-ts) codecs.

This language doesn't generate types of its own. It generates a runtime codec
for each type that the `typescript` language generates, and imports those types
so that every codec is annotated as `t.Type<types.Foo>`. If a codec and its
TypeScript type ever disagree, `tsc` reports an error.

Every codec is wrapped in `t.recursion`, which makes it lazy. That keeps the
output correct no matter what order types are written in, supports recursive
types, and lets bundlers drop unused codecs, because the only top-level call
for each codec is a `/* @__PURE__ */ t.recursion(...)`.
*/
use anyhow::Context;
use itertools::Itertools;
use serde::{Deserialize, Serialize};
use std::{
    borrow::Cow,
    collections::{BTreeSet, HashMap},
    io::Write,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, PoisonError,
    },
};
use typeshare_model::prelude::*;

/// io-ts language config
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Config {
    /// Mappings from Rust type names to io-ts codec expressions, for example
    /// `DateTime = "t.string"`. `t` is the io-ts import.
    #[serde(default, alias = "type_mappings")]
    type_mappings: HashMap<String, String>,

    /// Module the generated TypeScript types are imported from in single-file
    /// mode, for example `"./core"`. In multi-file mode each file imports from
    /// the matching `typeshare_{crate}` file instead.
    #[serde(default = "default_types_import", alias = "types_import")]
    types_import: String,

    /// Appended to a type's name to name its codec.
    #[serde(default = "default_codec_suffix", alias = "codec_suffix")]
    codec_suffix: String,

    /// Whether or not to exclude the version header that normally appears at
    /// the top of generated code.
    #[serde(default, alias = "no_version_header")]
    no_version_header: bool,
}

fn default_types_import() -> String {
    "./types".to_owned()
}

fn default_codec_suffix() -> String {
    "Codec".to_owned()
}

/// All information needed to generate io-ts codecs
#[derive(Debug)]
pub struct IoTs {
    type_mappings: HashMap<TypeName, String>,
    types_import: String,
    codec_suffix: String,
    no_version_header: bool,
    helpers: HelperUsage,
    /// Import statements for the current file. They're written just before
    /// the first codec, so a file with no codecs has no unused imports.
    pending_imports: Mutex<Option<String>>,
    /// The `[T; N]` lengths the current file uses. Each gets an explicit tuple
    /// type, since building large tuple types with spreads hits TypeScript's
    /// size limit.
    fixed_array_lengths: Mutex<BTreeSet<usize>>,
}

impl Language<'_> for IoTs {
    type Config = Config;

    const NAME: &'static str = "io-ts";

    fn new_from_config(config: Self::Config) -> anyhow::Result<Self> {
        anyhow::ensure!(
            !config.types_import.is_empty(),
            "types-import can't be empty"
        );

        Ok(Self {
            type_mappings: config
                .type_mappings
                .into_iter()
                .map(|(key, value)| (TypeName::new_string(key), value))
                .collect(),
            types_import: config.types_import,
            codec_suffix: config.codec_suffix,
            no_version_header: config.no_version_header,
            helpers: HelperUsage::default(),
            pending_imports: Mutex::default(),
            fixed_array_lengths: Mutex::default(),
        })
    }

    fn mapped_type(&self, type_name: &TypeName) -> Option<Cow<'_, str>> {
        self.type_mappings
            .get(type_name)
            .map(|codec| Cow::Borrowed(codec.as_str()))
    }

    fn output_filename_for_crate(&self, crate_name: &CrateName) -> String {
        format!("typeshare_{crate_name}_codecs.ts")
    }

    fn format_simple_type(
        &self,
        base: &TypeName,
        generic_context: &[TypeName],
    ) -> anyhow::Result<String> {
        // Generic parameters are codec arguments of the enclosing codec factory
        if generic_context.contains(base) {
            return Ok(base.to_string());
        }

        Ok(match self.mapped_type(base) {
            Some(mapped) => mapped.into_owned(),
            None => self.codec_name(base),
        })
    }

    fn format_generic_type(
        &self,
        base: &TypeName,
        parameters: &[RustType],
        generic_context: &[TypeName],
    ) -> anyhow::Result<String> {
        if parameters.is_empty() {
            return self.format_simple_type(base, generic_context);
        }

        if let Some(mapped) = self.mapped_type(base) {
            return Ok(mapped.into_owned());
        }

        let parameters = parameters
            .iter()
            .map(|parameter| self.format_type(parameter, generic_context))
            .collect::<anyhow::Result<Vec<_>>>()?;

        Ok(format!(
            "{}({})",
            self.codec_name(base),
            parameters.join(", ")
        ))
    }

    fn format_special_type(
        &self,
        special_ty: &SpecialRustType,
        generic_context: &[TypeName],
    ) -> anyhow::Result<String> {
        Ok(match special_ty {
            SpecialRustType::Vec(rtype) | SpecialRustType::Slice(rtype) => {
                format!("t.array({})", self.format_type(rtype, generic_context)?)
            }
            // `t.tuple` only has overloads for up to five elements, and it
            // drops extra elements instead of rejecting them
            SpecialRustType::Array(rtype, len) => {
                lock(&self.fixed_array_lengths).insert(*len);
                format!(
                    "{}({}, {len})",
                    self.use_helper(Helper::FixedArray),
                    self.format_type(rtype, generic_context)?
                )
            }
            // Like the typescript language, optionality is only expressed on
            // fields, enum variant content, and type aliases.
            SpecialRustType::Option(rtype) => self.format_type(rtype, generic_context)?,
            SpecialRustType::HashMap(key, value) => {
                let key = match key.as_ref() {
                    RustType::Simple { id } if generic_context.contains(id) => {
                        anyhow::bail!("can't use a generic type as a record key")
                    }
                    RustType::Special(SpecialRustType::String | SpecialRustType::Char) => {
                        self.format_type(key, generic_context)?
                    }
                    key => format!(
                        "{}({})",
                        self.use_helper(Helper::RecordKey),
                        self.format_type(key, generic_context)?
                    ),
                };

                format!(
                    "{}({key}, {})",
                    self.use_helper(Helper::Record),
                    self.format_type(value, generic_context)?
                )
            }
            // TypeScript types `()` as `undefined`, but serde writes it as `null`
            SpecialRustType::Unit => format!("{}(t.undefined)", self.use_helper(Helper::Optional)),
            SpecialRustType::String => "t.string".to_owned(),
            SpecialRustType::Char => format!("{}()", self.use_helper(Helper::Character)),
            SpecialRustType::I8 => self.integer("i8", "-128", "127"),
            SpecialRustType::U8 => self.integer("u8", "0", "255"),
            SpecialRustType::I16 => self.integer("i16", "-32768", "32767"),
            SpecialRustType::U16 => self.integer("u16", "0", "65535"),
            SpecialRustType::I32 => self.integer("i32", "-2147483648", "2147483647"),
            SpecialRustType::U32 => self.integer("u32", "0", "4294967295"),
            SpecialRustType::I54 => {
                self.integer("I54", "Number.MIN_SAFE_INTEGER", "Number.MAX_SAFE_INTEGER")
            }
            SpecialRustType::U53 => self.integer("U53", "0", "Number.MAX_SAFE_INTEGER"),
            SpecialRustType::F32 | SpecialRustType::F64 => "t.number".to_owned(),
            SpecialRustType::Bool => "t.boolean".to_owned(),
            SpecialRustType::U64
            | SpecialRustType::I64
            | SpecialRustType::ISize
            | SpecialRustType::USize => anyhow::bail!("can't use 64+ bit integers in io-ts"),
            ty => anyhow::bail!("unsupported type {ty:?}"),
        })
    }

    fn begin_file(&self, w: &mut impl Write, mode: FilesMode<&CrateName>) -> anyhow::Result<()> {
        self.helpers.reset();
        lock(&self.fixed_array_lengths).clear();

        if !self.no_version_header {
            writeln!(
                w,
                "/*\n\
                  Generated by typeshare {}\n\
                 */",
                env!("CARGO_PKG_VERSION")
            )?;
        }

        let types_import = match mode {
            FilesMode::Multi(crate_name) => Cow::Owned(format!("./typeshare_{crate_name}")),
            _ => Cow::Borrowed(self.types_import.as_str()),
        };

        *self.pending_imports() = Some(format!(
            "import * as t from \"io-ts\";\nimport * as types from {};\n",
            js_string(&types_import)
        ));

        Ok(())
    }

    fn write_imports<'a, Crates, Types>(
        &self,
        writer: &mut impl Write,
        _crate_name: &CrateName,
        imports: Crates,
    ) -> anyhow::Result<()>
    where
        Crates: IntoIterator<Item = (&'a CrateName, Types)>,
        Types: IntoIterator<Item = &'a TypeName>,
    {
        for (crate_name, types) in imports {
            let codecs = types
                .into_iter()
                .map(|type_name| self.codec_name(type_name))
                .join(", ");
            writeln!(
                writer,
                "import {{ {codecs} }} from \"./typeshare_{crate_name}_codecs\";"
            )?;
        }
        writeln!(writer)?;

        Ok(())
    }

    fn end_file(&self, w: &mut impl Write, _mode: FilesMode<&CrateName>) -> anyhow::Result<()> {
        self.pending_imports().take();

        // Function declarations are hoisted, so the helpers can follow the
        // codecs that call them.
        for helper in self.helpers.take_used() {
            writeln!(w, "{}\n", helper.source())?;

            if let Helper::FixedArray = helper {
                self.write_fixed_array_types(w)?;
            }
        }

        Ok(())
    }

    fn write_type_alias(&self, w: &mut impl Write, ty: &RustTypeAlias) -> anyhow::Result<()> {
        let codec = self.format_type(&ty.ty, &ty.generic_types)?;
        let codec = match ty.ty.is_optional() {
            true => format!("{}({codec})", self.use_helper(Helper::Optional)),
            false => codec,
        };

        self.write_codec(w, &ty.id.original, &ty.generic_types, &codec)
    }

    fn write_struct(&self, w: &mut impl Write, rs: &RustStruct) -> anyhow::Result<()> {
        let codec = self.object_codec(&rs.fields, &rs.generic_types)?;

        self.write_codec(w, &rs.id.original, &rs.generic_types, &codec)
    }

    fn write_enum(&self, w: &mut impl Write, e: &RustEnum) -> anyhow::Result<()> {
        let shared = e.shared();

        let codec = match e {
            RustEnum::Unit { .. } => format!(
                "{}<{}>({}, types.{})",
                self.use_helper(Helper::EnumCodec),
                type_reference(&shared.id.original, &shared.generic_types),
                js_string(shared.id.original.as_str()),
                shared.id.original,
            ),
            RustEnum::Algebraic {
                tag_key,
                content_key,
                variants,
                ..
            } => {
                let variants = variants
                    .iter()
                    .map(|variant| {
                        self.variant_codec(variant, tag_key, content_key, &shared.generic_types)
                            .with_context(|| {
                                format!("error writing variant {}", variant.shared().id.original)
                            })
                    })
                    .collect::<anyhow::Result<Vec<_>>>()?;

                match variants.as_slice() {
                    [] => "t.never".to_owned(),
                    [variant] => variant.clone(),
                    variants => list("t.union", variants),
                }
            }
        };

        self.write_codec(w, &shared.id.original, &shared.generic_types, &codec)
    }

    fn write_const(&self, _w: &mut impl Write, _c: &RustConst) -> anyhow::Result<()> {
        // Constants are values, not types, so they don't need a codec
        Ok(())
    }

    fn exclude_from_import_analysis(&self, name: &TypeName) -> bool {
        self.type_mappings.contains_key(name)
    }
}

impl IoTs {
    fn codec_name(&self, type_name: &TypeName) -> String {
        format!("{type_name}{}", self.codec_suffix)
    }

    fn pending_imports(&self) -> std::sync::MutexGuard<'_, Option<String>> {
        lock(&self.pending_imports)
    }

    /// The tuple type for each `[T; N]` length in the file, which the
    /// `fixedArray` helper looks up by length
    fn write_fixed_array_types(&self, w: &mut impl Write) -> anyhow::Result<()> {
        writeln!(w, "interface FixedArrays<T> {{")?;

        for len in lock(&self.fixed_array_lengths).iter() {
            writeln!(
                w,
                "\t{len}: [{}];",
                std::iter::repeat_n("T", *len).join(", ")
            )?;
        }

        writeln!(w, "}}\n")?;

        Ok(())
    }

    fn use_helper(&self, helper: Helper) -> &'static str {
        self.helpers.mark(helper);
        helper.name()
    }

    fn integer(&self, name: &str, min: &str, max: &str) -> String {
        format!(
            "{}({}, {min}, {max})",
            self.use_helper(Helper::Integer),
            js_string(name)
        )
    }

    /// Writes one exported codec. Generic types become functions that take a
    /// codec for each generic parameter.
    fn write_codec(
        &self,
        w: &mut impl Write,
        name: &TypeName,
        generic_types: &[TypeName],
        codec: &str,
    ) -> anyhow::Result<()> {
        if let Some(imports) = self.pending_imports().take() {
            writeln!(w, "{imports}")?;
        }

        let type_ref = type_reference(name, generic_types);
        let codec_name = self.codec_name(name);

        if generic_types.is_empty() {
            writeln!(
                w,
                "export const {codec_name}: t.Type<{type_ref}> = /* @__PURE__ */ t.recursion<{type_ref}>({}, () => {codec});\n",
                js_string(name.as_str()),
            )?;
        } else {
            let type_parameters = generic_types.iter().join(", ");
            let parameters = generic_types
                .iter()
                .map(|generic| format!("{generic}: t.Type<{generic}>"))
                .join(", ");
            let name = format!(
                "`{name}<{}>`",
                generic_types
                    .iter()
                    .map(|generic| format!("${{{generic}.name}}"))
                    .join(", ")
            );

            writeln!(
                w,
                "export const {codec_name} = <{type_parameters}>({parameters}): t.Type<{type_ref}> => t.recursion<{type_ref}>({name}, () => {codec});\n",
            )?;
        }

        Ok(())
    }

    /// Codec for a struct, or for the content of an anonymous struct variant
    fn object_codec(
        &self,
        fields: &[RustField],
        generic_types: &[TypeName],
    ) -> anyhow::Result<String> {
        let mut properties = Properties::default();

        for field in fields {
            let (presence, codec) = self
                .field_codec(field, generic_types)
                .with_context(|| format!("error writing field {}", field.id.original))?;
            properties.add(presence, property_key(field.id.renamed.as_str())?, codec);
        }

        Ok(self.properties_codec(&properties))
    }

    fn field_codec(
        &self,
        field: &RustField,
        generic_types: &[TypeName],
    ) -> anyhow::Result<(Presence, String)> {
        // An override replaces the codec for the field's type. Whether the
        // field can be missing or null still follows the Rust type, like the
        // typescript language.
        let codec = match field.decorators.type_override_for_lang("io_ts") {
            Some(codec) => codec.to_owned(),
            None => {
                // An overridden TypeScript type can't be checked by a generated codec
                anyhow::ensure!(
                    field
                        .decorators
                        .type_override_for_lang("typescript")
                        .is_none(),
                    "field has a typescript type override, so it needs an io-ts one too, \
                    such as #[typeshare(io_ts(type = \"t.string\"))]"
                );

                self.format_type(&field.ty, generic_types)?
            }
        };

        // Matches the typescript language: `Option<Option<T>>` is `T | null`,
        // and `Option<T>` is an optional `T`.
        Ok(if field.ty.is_double_optional() {
            // `t.null` goes first, since the base codec might also accept null
            (Presence::Optional, format!("t.union([t.null, {codec}])"))
        } else if field.ty.is_optional() {
            (Presence::Nullable, codec)
        } else if field.has_default {
            (Presence::Optional, codec)
        } else {
            (Presence::Required, codec)
        })
    }

    /// Every object goes through the `fields` helper rather than `t.type` and
    /// `t.partial` directly, so `null` options, properties named like
    /// `Object.prototype` members, and `__proto__` keys in the input are
    /// handled the same way everywhere.
    fn properties_codec(&self, properties: &Properties) -> String {
        format!(
            "{}({}, {}, {})",
            self.use_helper(Helper::Fields),
            object_literal(&properties.required),
            object_literal(&properties.nullable),
            object_literal(&properties.optional),
        )
    }

    fn variant_codec(
        &self,
        variant: &RustEnumVariant,
        tag_key: &str,
        content_key: &str,
        generic_types: &[TypeName],
    ) -> anyhow::Result<String> {
        let tag = (
            property_key(tag_key)?,
            format!(
                "t.literal({})",
                js_string(variant.shared().id.renamed.as_str())
            ),
        );
        let content_key = property_key(content_key)?;

        let mut properties = Properties::default();
        properties.add(Presence::Required, tag.0, tag.1);

        match variant {
            // serde accepts a missing or null content for unit variants
            RustEnumVariant::Unit(_) => {
                properties.add(Presence::Nullable, content_key, "t.undefined".to_owned());
            }
            RustEnumVariant::Tuple { ty, .. } => {
                let codec = self.format_type(ty, generic_types)?;
                let presence = match ty.is_optional() {
                    true => Presence::Nullable,
                    false => Presence::Required,
                };
                properties.add(presence, content_key, codec);
            }
            RustEnumVariant::AnonymousStruct { fields, .. } => {
                let codec = self.object_codec(fields, generic_types)?;
                properties.add(Presence::Required, content_key, codec);
            }
            variant => anyhow::bail!("unsupported enum variant {variant:?}"),
        }

        Ok(self.properties_codec(&properties))
    }
}

/// Runtime helpers that generated codecs can call. Only the ones a file uses
/// are written to it.
#[derive(Debug, Clone, Copy)]
enum Helper {
    Optional,
    Fields,
    Integer,
    Character,
    EnumCodec,
    RecordKey,
    Record,
    FixedArray,
}

impl Helper {
    const ALL: [Self; 8] = [
        Self::Optional,
        Self::Fields,
        Self::Integer,
        Self::Character,
        Self::EnumCodec,
        Self::RecordKey,
        Self::Record,
        Self::FixedArray,
    ];

    fn name(self) -> &'static str {
        match self {
            Self::Optional => "optional",
            Self::Fields => "fields",
            Self::Integer => "integer",
            Self::Character => "character",
            Self::EnumCodec => "enumCodec",
            Self::RecordKey => "recordKey",
            Self::Record => "record",
            Self::FixedArray => "fixedArray",
        }
    }

    fn source(self) -> &'static str {
        match self {
            Self::Optional => include_str!("helpers/optional.ts").trim_end(),
            Self::Fields => include_str!("helpers/fields.ts").trim_end(),
            Self::Integer => include_str!("helpers/integer.ts").trim_end(),
            Self::Character => include_str!("helpers/character.ts").trim_end(),
            Self::EnumCodec => include_str!("helpers/enum_codec.ts").trim_end(),
            Self::RecordKey => include_str!("helpers/record_key.ts").trim_end(),
            Self::Record => include_str!("helpers/record.ts").trim_end(),
            Self::FixedArray => include_str!("helpers/fixed_array.ts").trim_end(),
        }
    }
}

/// How a property can appear in serialized data
#[derive(Debug, Clone, Copy)]
enum Presence {
    /// Always present
    Required,
    /// `Option<T>`: may be missing, and `null` counts as missing
    Nullable,
    /// `#[serde(default)]` or `Option<Option<T>>`: may be missing
    Optional,
}

/// The properties of an object codec, grouped by presence
#[derive(Debug, Default)]
struct Properties {
    required: Vec<(String, String)>,
    nullable: Vec<(String, String)>,
    optional: Vec<(String, String)>,
}

impl Properties {
    fn add(&mut self, presence: Presence, key: String, codec: String) {
        let group = match presence {
            Presence::Required => &mut self.required,
            Presence::Nullable => &mut self.nullable,
            Presence::Optional => &mut self.optional,
        };
        group.push((key, codec));
    }
}

/// Tracks which helpers the current file uses. typeshare writes files one at a
/// time, so this is reset at the start of each file.
#[derive(Debug, Default)]
struct HelperUsage([AtomicBool; Helper::ALL.len()]);

impl HelperUsage {
    fn mark(&self, helper: Helper) {
        self.0[helper as usize].store(true, Ordering::Relaxed);
    }

    fn reset(&self) {
        for used in &self.0 {
            used.store(false, Ordering::Relaxed);
        }
    }

    fn take_used(&self) -> impl Iterator<Item = Helper> + '_ {
        Helper::ALL
            .into_iter()
            .filter(|&helper| self.0[helper as usize].swap(false, Ordering::Relaxed))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// The TypeScript type a codec is checked against, such as `types.Foo<T>`
fn type_reference(name: &TypeName, generic_types: &[TypeName]) -> String {
    match generic_types.is_empty() {
        true => format!("types.{name}"),
        false => format!("types.{name}<{}>", generic_types.iter().join(", ")),
    }
}

fn object_literal(properties: &[(String, String)]) -> String {
    if properties.is_empty() {
        return "{}".to_owned();
    }

    let body: String = properties
        .iter()
        .map(|(key, codec)| format!("\t{key}: {},\n", indent(codec)))
        .collect();

    format!("{{\n{body}}}")
}

fn list(constructor: &str, items: &[String]) -> String {
    let body: String = items
        .iter()
        .map(|item| format!("\t{},\n", indent(item)))
        .collect();

    format!("{constructor}([\n{body}])")
}

/// Indents every line after the first. Generated expressions never contain
/// newlines inside string literals, so this only touches code.
fn indent(expression: &str) -> String {
    expression.replace('\n', "\n\t")
}

/// An object literal key, quoted unless it's a valid identifier
fn property_key(name: &str) -> anyhow::Result<String> {
    // io-ts copies and merges objects with plain assignment, which sets the
    // prototype instead of adding a `__proto__` property, so it can't be
    // checked reliably
    anyhow::ensure!(
        name != "__proto__",
        "io-ts can't check a property named __proto__"
    );

    let mut chars = name.chars();
    let is_identifier = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');

    Ok(match is_identifier {
        true => name.to_owned(),
        false => js_string(name),
    })
}

/// A double-quoted JavaScript string literal
fn js_string(value: &str) -> String {
    let mut literal = String::with_capacity(value.len() + 2);
    literal.push('"');

    for c in value.chars() {
        match c {
            '"' => literal.push_str("\\\""),
            '\\' => literal.push_str("\\\\"),
            '\n' => literal.push_str("\\n"),
            '\r' => literal.push_str("\\r"),
            '\t' => literal.push_str("\\t"),
            c if c.is_control() => literal.push_str(&format!("\\u{:04x}", c as u32)),
            c => literal.push(c),
        }
    }

    literal.push('"');
    literal
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn quotes_keys_that_are_not_identifiers() {
        assert_eq!(property_key("camelCase").unwrap(), "camelCase");
        assert_eq!(property_key("$_ok9").unwrap(), "$_ok9");
        assert_eq!(property_key("kebab-case").unwrap(), "\"kebab-case\"");
        assert_eq!(property_key("9lives").unwrap(), "\"9lives\"");
        assert_eq!(property_key("").unwrap(), "\"\"");
    }

    #[test]
    fn rejects_proto_keys() {
        assert!(property_key("__proto__").is_err());
    }

    #[test]
    fn escapes_string_literals() {
        assert_eq!(js_string(r#"say "hi"\"#), r#""say \"hi\"\\""#);
        assert_eq!(js_string("a\nb\u{1}"), "\"a\\nb\\u0001\"");
        assert_eq!(js_string("café"), "\"café\"");
    }

    #[test]
    fn indents_nested_expressions() {
        let inner = object_literal(&[("a".to_owned(), "t.string".to_owned())]);
        let outer = object_literal(&[("b".to_owned(), inner)]);

        assert_eq!(outer, "{\n\tb: {\n\t\ta: t.string,\n\t},\n}");
    }
}
