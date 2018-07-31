import { setUnion, arrayIntercalate, toReadonlyArray, iterableFirst, iterableFind } from "collection-utils";

import { TargetLanguage } from "../TargetLanguage";
import { Type, ClassType, ClassProperty, EnumType, UnionType } from "../Type";
import { nullableFromUnion, matchType, removeNullFromUnion, isNamedType, directlyReachableTypes } from "../TypeUtils";
import { Name, Namer, funPrefixNamer, DependencyName } from "../Naming";
import { Sourcelike, maybeAnnotated } from "../Source";
import { anyTypeIssueAnnotation, nullTypeIssueAnnotation } from "../Annotation";
import {
    legalizeCharacters,
    isAscii,
    isLetterOrUnderscoreOrDigit,
    stringEscape,
    NamingStyle,
    makeNameStyle
} from "../support/Strings";
import { defined, assertNever, panic } from "../support/Support";
import { ConvenienceRenderer, ForbiddenWordsInfo } from "../ConvenienceRenderer";
import { StringOption, EnumOption, BooleanOption, Option, getOptionValues, OptionValues } from "../RendererOptions";
import { assert } from "../support/Support";
import { Declaration } from "../DeclarationIR";
import { RenderContext } from "../Renderer";
import { getAccessorName } from "../AccessorNames";
import { enumCaseValues } from "../EnumValues";

const pascalValue: [string, NamingStyle] = ["pascal-case", "pascal"];
const underscoreValue: [string, NamingStyle] = ["underscore-case", "underscore"];
const camelValue: [string, NamingStyle] = ["camel-case", "camel"];
const upperUnderscoreValue: [string, NamingStyle] = ["upper-underscore-case", "upper-underscore"];
const pascalUpperAcronymsValue: [string, NamingStyle] = ["pascal-case-upper-acronyms", "pascal-upper-acronyms"];
const camelUpperAcronymsValue: [string, NamingStyle] = ["camel-case-upper-acronyms", "camel-upper-acronyms"];

export const cPlusPlusOptions = {
    typeSourceStyle: new EnumOption("source-style", "Source code generation type,  whether to generate single or multiple source files",
        [["single-source", true], ["multi-source", false]],
        "single-source",
        "secondary"
    ),
    includeLocation: new EnumOption("include-location", "Whether json.hpp is to be located globally or locally", 
        [["local-include", true], ["global-include", false]],
        "local-include",
        "secondary"
    ),
    codeFormat: new EnumOption("code-format", "Generate classes with getters/setters, instead of structs", 
        [["with-struct", false], ["with-getter-setter", true]],
        "with-struct",
        "secondary"
    ),
    generateStringConverter: new BooleanOption("generate-string-converter", "If set a helper function is generated which can dump the structure", false),
    justTypes: new BooleanOption("just-types", "Plain types only", false),
    namespace: new StringOption("namespace", "Name of the generated namespace(s)", "NAME", "quicktype"),
    typeNamingStyle: new EnumOption<NamingStyle>("type-style", "Naming style for types", [
        pascalValue,
        underscoreValue,
        camelValue,
        upperUnderscoreValue,
        pascalUpperAcronymsValue,
        camelUpperAcronymsValue
    ]),
    memberNamingStyle: new EnumOption<NamingStyle>("member-style", "Naming style for members", [
        underscoreValue,
        pascalValue,
        camelValue,
        upperUnderscoreValue,
        pascalUpperAcronymsValue,
        camelUpperAcronymsValue
    ]),
    enumeratorNamingStyle: new EnumOption<NamingStyle>("enumerator-style", "Naming style for enumerators", [
        upperUnderscoreValue,
        underscoreValue,
        pascalValue,
        camelValue,
        pascalUpperAcronymsValue,
        camelUpperAcronymsValue
    ])
};

export class CPlusPlusTargetLanguage extends TargetLanguage {
    constructor(displayName: string = "C++", names: string[] = ["c++", "cpp", "cplusplus"], extension: string = "cpp") {
        super(displayName, names, extension);
    }

    protected getOptions(): Option<any>[] {
        return [
            cPlusPlusOptions.justTypes,
            cPlusPlusOptions.generateStringConverter,
            cPlusPlusOptions.typeSourceStyle,
            cPlusPlusOptions.includeLocation,
            cPlusPlusOptions.codeFormat,
            cPlusPlusOptions.namespace,
            cPlusPlusOptions.typeNamingStyle,
            cPlusPlusOptions.memberNamingStyle,
            cPlusPlusOptions.enumeratorNamingStyle
        ];
    }

    get supportsUnionsWithBothNumberTypes(): boolean {
        return true;
    }

    protected makeRenderer(
        renderContext: RenderContext,
        untypedOptionValues: { [name: string]: any }
    ): CPlusPlusRenderer {
        return new CPlusPlusRenderer(this, renderContext, getOptionValues(cPlusPlusOptions, untypedOptionValues));
    }
}

const legalizeName = legalizeCharacters(cp => isAscii(cp) && isLetterOrUnderscoreOrDigit(cp));

const keywords = [
    "alignas",
    "alignof",
    "and",
    "and_eq",
    "asm",
    "atomic_cancel",
    "atomic_commit",
    "atomic_noexcept",
    "auto",
    "bitand",
    "bitor",
    "bool",
    "break",
    "case",
    "catch",
    "char",
    "char16_t",
    "char32_t",
    "class",
    "compl",
    "concept",
    "const",
    "constexpr",
    "const_cast",
    "continue",
    "co_await",
    "co_return",
    "co_yield",
    "decltype",
    "default",
    "delete",
    "do",
    "double",
    "dynamic_cast",
    "else",
    "enum",
    "explicit",
    "export",
    "extern",
    "false",
    "float",
    "for",
    "friend",
    "goto",
    "if",
    "import",
    "inline",
    "int",
    "long",
    "module",
    "mutable",
    "namespace",
    "new",
    "noexcept",
    "not",
    "not_eq",
    "nullptr",
    "operator",
    "or",
    "or_eq",
    "private",
    "protected",
    "public",
    "register",
    "reinterpret_cast",
    "requires",
    "return",
    "short",
    "signed",
    "sizeof",
    "static",
    "static_assert",
    "static_cast",
    "struct",
    "switch",
    "synchronized",
    "template",
    "this",
    "thread_local",
    "throw",
    "true",
    "try",
    "typedef",
    "typeid",
    "typename",
    "union",
    "unsigned",
    "using",
    "virtual",
    "void",
    "volatile",
    "wchar_t",
    "while",
    "xor",
    "xor_eq",
    "override",
    "final",
    "transaction_safe",
    "transaction_safe_dynamic",
    "NULL"
];

/**
 * This is a bit problematic. If you are using getters/setter
 * you simply do NOT want to return a unique_ptr from a getter as
 * that on its own violates the pure reason of using unique_ptrs.
 * However just to satisfy the "optional" attribute, .e.g whether a
 * given structure / member exists or not, using shared_ptr is just fine.
 * [obviously std::optional would be the best, but that's C++14]
 */
const optionalType = "std::shared_ptr";

export type TypeContext = {
    needsForwardIndirection: boolean;
    needsOptionalIndirection: boolean;
    inJsonNamespace: boolean;
};

export class CPlusPlusRenderer extends ConvenienceRenderer {
    private _currentFilename: string | undefined;
    private _allTypeNames: Set<string>;
    private readonly _gettersAndSettersForPropertyName = new Map<Name, [Name, Name, Name]>();
    private readonly _namespaceNames: ReadonlyArray<string>;

    private readonly _memberNamingFunction: Namer;

    protected readonly typeNamingStyle: NamingStyle;
    protected readonly enumeratorNamingStyle: NamingStyle;

    constructor(
        targetLanguage: TargetLanguage,
        renderContext: RenderContext,
        private readonly _options: OptionValues<typeof cPlusPlusOptions>
    ) {
        super(targetLanguage, renderContext);

        this._namespaceNames = _options.namespace.split("::");

        this.typeNamingStyle = _options.typeNamingStyle;
        this.enumeratorNamingStyle = _options.enumeratorNamingStyle;

        this._memberNamingFunction = funPrefixNamer("members", makeNameStyle(_options.memberNamingStyle, legalizeName));
        this._gettersAndSettersForPropertyName = new Map();

        this._allTypeNames = new Set<string>();
    }

    protected forbiddenNamesForGlobalNamespace(): string[] {
        return keywords;
    }

    protected forbiddenForObjectProperties(_c: ClassType, _className: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected forbiddenForEnumCases(_e: EnumType, _enumName: Name): ForbiddenWordsInfo {
        return { names: [], includeGlobalForbidden: true };
    }

    protected makeNamedTypeNamer(): Namer {
        return funPrefixNamer("types", makeNameStyle(this.typeNamingStyle, legalizeName));
    }

    protected namerForObjectProperty(): Namer {
        return this._memberNamingFunction;
    }

    protected makeUnionMemberNamer(): null {
        return null;
    }

    protected makeEnumCaseNamer(): Namer {
        return funPrefixNamer("enumerators", makeNameStyle(this.enumeratorNamingStyle, legalizeName));
    }

    protected makeNamesForPropertyGetterAndSetter(
        _c: ClassType,
        _className: Name,
        _p: ClassProperty,
        _jsonName: string,
        name: Name
    ): [Name, Name, Name] {
        const getterName = new DependencyName(this._memberNamingFunction, name.order, lookup => `get_${lookup(name)}`);
        const mutableGetterName = new DependencyName(this._memberNamingFunction, name.order, lookup => `getMutable_${lookup(name)}`);
        const setterName = new DependencyName(this._memberNamingFunction, name.order, lookup => `set_${lookup(name)}`);
        return [getterName, mutableGetterName, setterName];
    }

    protected makePropertyDependencyNames(
        c: ClassType,
        className: Name,
        p: ClassProperty,
        jsonName: string,
        name: Name
    ): Name[] {
        const getterAndSetterNames = this.makeNamesForPropertyGetterAndSetter(c, className, p, jsonName, name);
        this._gettersAndSettersForPropertyName.set(name, getterAndSetterNames);
        return getterAndSetterNames;
    }

    protected startFile(basename: Sourcelike, includeHelper: boolean = true): void {
        assert(this._currentFilename === undefined, "Previous file wasn't finished");
        if (basename !== undefined) {
            this._currentFilename = this.sourcelikeToString(basename);
        }

        if (this.leadingComments !== undefined) {
            this.emitCommentLines(this.leadingComments);
        } else if (!this._options.justTypes) {
            this.emitCommentLines([
                " To parse this JSON data, first install",
                "",
                "     Boost     http://www.boost.org",
                "     json.hpp  https://github.com/nlohmann/json",
                "",
                " Then include this file, and then do",
                ""
            ]);

            if (this._options.typeSourceStyle) {
                this.forEachTopLevel("none", (_, topLevelName) => {
                    this.emitLine(
                        "//     ",
                        this.ourQualifier(false),
                        topLevelName,
                        " data = nlohmann::json::parse(jsonString);"
                    );
                });
            } else {
                this.emitLine(
                    "//     ",
                    this.ourQualifier(false),
                    basename,
                    " data = nlohmann::json::parse(jsonString);"
                );
            }
        }
        this.ensureBlankLine();

        this.emitLine("#pragma once");
        this.ensureBlankLine();

        const include = (name: string): void => {
            this.emitLine(`#include ${name}`);
        };
        if (this.haveNamedUnions) include("<boost/variant.hpp>");
        if (!this._options.justTypes) {
            if (!this._options.includeLocation) {
                include("<nlohmann/json.hpp>");
            } else {
                include("\"json.hpp\"");
            }

            if (includeHelper && !this._options.typeSourceStyle) {
                include("\"helper.hpp\"");
            }
        }
        this.ensureBlankLine();
    }

    protected finishFile(): void {
        super.finishFile(defined(this._currentFilename));
        this._currentFilename = undefined;
    }

    protected get needsTypeDeclarationBeforeUse(): boolean {
        return true;
    }

    protected canBeForwardDeclared(t: Type): boolean {
        const kind = t.kind;
        return kind === "class";
    }

    protected emitDescriptionBlock(lines: string[]): void {
        this.emitCommentLines(lines, " * ", "/**", " */");
    }

    protected emitBlock(line: Sourcelike, withSemicolon: boolean, f: () => void, withIndent: boolean = true): void {
        this.emitLine(line, " {");
        this.preventBlankLine();
        if (withIndent) {
            this.indent(f);
        } else {
            f();
        }
        this.preventBlankLine();
        if (withSemicolon) {
            this.emitLine("};");
        } else {
            this.emitLine("}");
        }
    }

    protected emitNamespaces(namespaceNames: Iterable<string>, f: () => void): void {
        const namesArray = toReadonlyArray(namespaceNames);
        const first = namesArray[0];
        if (first === undefined) {
            f();
        } else {
            this.emitBlock(
                ["namespace ", first],
                false,
                () => this.emitNamespaces(namesArray.slice(1), f),
                namesArray.length === 1
            );
        }
    }

    protected cppTypeInOptional(nonNulls: ReadonlySet<Type>, ctx: TypeContext, withIssues: boolean): Sourcelike {
        if (nonNulls.size === 1) {
            return this.cppType(defined(iterableFirst(nonNulls)), ctx, withIssues);
        }
        const typeList: Sourcelike = [];
        for (const t of nonNulls) {
            if (typeList.length !== 0) {
                typeList.push(", ");
            }
            typeList.push(
                this.cppType(
                    t,
                    {
                        needsForwardIndirection: true,
                        needsOptionalIndirection: false,
                        inJsonNamespace: ctx.inJsonNamespace
                    },
                    withIssues
                )
            );
        }
        return ["boost::variant<", typeList, ">"];
    }

    protected variantType(u: UnionType, inJsonNamespace: boolean): Sourcelike {
        const [maybeNull, nonNulls] = removeNullFromUnion(u, true);
        assert(nonNulls.size >= 2, "Variant not needed for less than two types.");
        const indirection = maybeNull !== null;
        const variant = this.cppTypeInOptional(
            nonNulls,
            { needsForwardIndirection: !indirection, needsOptionalIndirection: !indirection, inJsonNamespace },
            true
        );
        if (!indirection) {
            return variant;
        }
        return [optionalType, "<", variant, ">"];
    }

    protected ourQualifier(inJsonNamespace: boolean): Sourcelike {
        return inJsonNamespace ? [arrayIntercalate("::", this._namespaceNames), "::"] : [];
    }

    protected jsonQualifier(inJsonNamespace: boolean): Sourcelike {
        return inJsonNamespace ? [] : "nlohmann::";
    }

    protected variantIndirection(needIndirection: boolean, typeSrc: Sourcelike): Sourcelike {
        if (!needIndirection) return typeSrc;
        return [optionalType, "<", typeSrc, ">"];
    }

    protected cppType(t: Type, ctx: TypeContext, withIssues: boolean): Sourcelike {
        const inJsonNamespace = ctx.inJsonNamespace;
        return matchType<Sourcelike>(
            t,
            _anyType =>
                maybeAnnotated(withIssues, anyTypeIssueAnnotation, [this.jsonQualifier(inJsonNamespace), "json"]),
            _nullType =>
                maybeAnnotated(withIssues, nullTypeIssueAnnotation, [this.jsonQualifier(inJsonNamespace), "json"]),
            _boolType => "bool",
            _integerType => "int64_t",
            _doubleType => "double",
            _stringType => "std::string",
            arrayType => [
                "std::vector<",
                this.cppType(
                    arrayType.items,
                    { needsForwardIndirection: false, needsOptionalIndirection: true, inJsonNamespace },
                    withIssues
                ),
                ">"
            ],
            classType =>
                this.variantIndirection(ctx.needsForwardIndirection && this.isForwardDeclaredType(classType), [
                    this.ourQualifier(inJsonNamespace),
                    this.nameForNamedType(classType)
                ]),
            mapType => [
                "std::map<std::string, ",
                this.cppType(
                    mapType.values,
                    { needsForwardIndirection: false, needsOptionalIndirection: true, inJsonNamespace },
                    withIssues
                ),
                ">"
            ],
            enumType => [this.ourQualifier(inJsonNamespace), this.nameForNamedType(enumType)],
            unionType => {
                const nullable = nullableFromUnion(unionType);
                if (nullable === null) return [this.ourQualifier(inJsonNamespace), this.nameForNamedType(unionType)];
                return [
                    optionalType,
                    "<",
                    this.cppType(
                        nullable,
                        { needsForwardIndirection: false, needsOptionalIndirection: false, inJsonNamespace },
                        withIssues
                    ),
                    ">"
                ];
            }
        );
    }

    protected emitClassMembers(c: ClassType): void {
        if (this._options.codeFormat) {
            this.emitLine("private:");
            this.ensureBlankLine();

            this.forEachClassProperty(c, "none", (name, _jsonName, property) => {
                this.emitLine(this.cppType(property.type, { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: false }, true), " ", name, ";");
            });

            this.emitLine("public:");
            this.ensureBlankLine();
        }

        this.forEachClassProperty(c, "leading-and-interposing", (name, jsonName, property) => {
            this.emitDescription(this.descriptionForClassProperty(c, jsonName));
            if (!this._options.codeFormat) {
                this.emitLine(this.cppType(property.type, { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: false }, true), " ", name, ";");
            } else {
                const [getterName, mutableGetterName, setterName] = defined(this._gettersAndSettersForPropertyName.get(name));
                const rendered = this.cppType(property.type, { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: false }, true);

                /** fix for optional type -> e.g. unique_ptrs can't be copied */
                if (property.type instanceof UnionType && property.type.findMember("null") !== undefined) {
                    this.emitLine(rendered, " ", getterName, "() const { return ", name, "; }");
                    this.emitLine("void ", setterName, "(", rendered, " value) { ", name, " = std::move(value); }");   
                } else {
                    this.emitLine("const ", rendered, " & ", getterName, "() const { return ", name, "; }");
                    this.emitLine(rendered, " & ", mutableGetterName, "() { return ", name, "; }");
                    this.emitLine("void ", setterName, "(const ", rendered, "& value) { ", name, " = value; }");   
                }
            }
        });
    }

    protected emitClass(c: ClassType, className: Name): void {
        this.emitDescription(this.descriptionForType(c));
        this.emitBlock([ this._options.codeFormat ? "class " : "struct ", className], true, () => {
            if (this._options.codeFormat) {
                this.emitLine("public:");
                this.ensureBlankLine();
                this.emitLine(className, "() = default;");
                this.emitLine("virtual ~", className, "() = default;");
                this.ensureBlankLine();

                if (this._options.generateStringConverter) {
                    this.emitBlock(["friend std::ostream& operator<<(std::ostream& os, ", className, " const& ms)"], false, () => {
                        this.forEachClassProperty(c, "none", (name, _jsonName, property) => {
                            const [getterName, , ] = defined(this._gettersAndSettersForPropertyName.get(name));
                            if (property.type.kind === "array") {
                                this.emitLine("os << \"", name, " : \" << stringify(ms.", getterName, "()) << std::endl;");
                            } else if (property.type.kind === "enum") {
                                this.emitLine("os << \"", name, " : \" << as_integer(ms.", getterName, "()) << std::endl;");
                            } else {
                                this.emitLine("os << \"", name, " : \" << ms.", getterName, "() << std::endl;");
                            }
                        });

                        this.emitLine("return os;");
                    });
                }
            }

            this.emitClassMembers(c);
        });
    }

    protected emitClassFunctions(c: ClassType, className: Name): void {
        const ourQualifier = this.ourQualifier(true);
        this.emitBlock(
            ["inline void from_json(const json& _j, ", ourQualifier, className, "& _x)"],
            false,
            () => {
                this.forEachClassProperty(c, "none", (name, json, p) => {
                    const [, , setterName] = defined(this._gettersAndSettersForPropertyName.get(name));
                    const t = p.type;
                    if (t instanceof UnionType) {
                        const [maybeNull, nonNulls] = removeNullFromUnion(t, true);
                        if (maybeNull !== null) {
                            if (this._options.codeFormat) {
                                this.emitLine(
                                    "_x.",
                                    setterName,
                                    "( ",
                                    ourQualifier,
                                    "get_optional<",
                                    this.cppTypeInOptional(
                                        nonNulls,
                                        {
                                            needsForwardIndirection: false,
                                            needsOptionalIndirection: false,
                                            inJsonNamespace: true
                                        },
                                        false
                                    ),
                                    '>(_j, "',
                                    stringEscape(json),
                                    '") );'
                                );
                            } else {
                                this.emitLine(
                                    "_x.",
                                    name,
                                    " = ",
                                    ourQualifier,
                                    "get_optional<",
                                    this.cppTypeInOptional(
                                        nonNulls,
                                        {
                                            needsForwardIndirection: false,
                                            needsOptionalIndirection: false,
                                            inJsonNamespace: true
                                        },
                                        false
                                    ),
                                    '>(_j, "',
                                    stringEscape(json),
                                    '");'
                                );
                            }
                            return;
                        }
                    }
                    if (t.kind === "null" || t.kind === "any") {
                        if (this._options.codeFormat) {
                            this.emitLine("_x.", setterName, "( ", ourQualifier, 'get_untyped(_j, "', stringEscape(json), '") );');
                        } else {
                            this.emitLine("_x.", name, " = ", ourQualifier, 'get_untyped(_j, "', stringEscape(json), '");');
                        }
                        return;
                    }
                    const cppType = this.cppType(
                        t,
                        { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: true },
                        false
                    );
                    if (this._options.codeFormat) {
                        this.emitLine("_x.", setterName, '( _j.at("', stringEscape(json), '").get<', cppType, ">() );");
                    } else {
                        this.emitLine("_x.", name, ' = _j.at("', stringEscape(json), '").get<', cppType, ">();");
                    }
                });
            }
        );
        this.ensureBlankLine();
        this.emitBlock(["inline void to_json(json& _j, const ", ourQualifier, className, "& _x)"], false, () => {
            this.emitLine("_j = json::object();");
            this.forEachClassProperty(c, "none", (name, json, _) => {
                const [getterName, , ] = defined(this._gettersAndSettersForPropertyName.get(name));
                if (this._options.codeFormat) {
                    this.emitLine('_j["', stringEscape(json), '"] = _x.', getterName, "();");
                } else {
                    this.emitLine('_j["', stringEscape(json), '"] = _x.', name, ";");
                }
            });
        });
    }

    protected emitEnum(e: EnumType, enumName: Name): void {
        const caseNames: Sourcelike[] = [];
        const enumValues = enumCaseValues(e, this.targetLanguage.name );

        this.forEachEnumCase(e, "none", (name, jsonName) => {
            if (caseNames.length > 0) caseNames.push(", ");
            caseNames.push(name);

            if (enumValues !== undefined) {
                const [ enumValue, ] = getAccessorName(enumValues, jsonName);
                if (enumValue !== undefined) {
                    caseNames.push(" = ", enumValue.toString());
                }
            }
        });
        this.emitDescription(this.descriptionForType(e));
        this.emitLine("enum class ", enumName, " { ", caseNames, " };");
    }

    protected emitUnionTypedefs(u: UnionType, unionName: Name): void {
        this.emitLine("typedef ", this.variantType(u, false), " ", unionName, ";");
    }

    protected emitUnionFunctions(u: UnionType): void {
        const functionForKind: [string, string][] = [
            ["bool", "is_boolean"],
            ["integer", "is_number_integer"],
            ["double", "is_number"],
            ["string", "is_string"],
            ["class", "is_object"],
            ["map", "is_object"],
            ["array", "is_array"],
            ["enum", "is_string"]
        ];
        const nonNulls = removeNullFromUnion(u, true)[1];
        const variantType = this.cppTypeInOptional(
            nonNulls,
            { needsForwardIndirection: false, needsOptionalIndirection: false, inJsonNamespace: true },
            false
        );
        this.emitBlock(["inline void from_json(const json& _j, ", variantType, "& _x)"], false, () => {
            let onFirst = true;
            for (const [kind, func] of functionForKind) {
                const typeForKind = iterableFind(nonNulls, t => t.kind === kind);
                if (typeForKind === undefined) continue;
                this.emitLine(onFirst ? "if" : "else if", " (_j.", func, "())");
                this.indent(() => {
                    this.emitLine(
                        "_x = _j.get<",
                        this.cppType(
                            typeForKind,
                            { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: true },
                            false
                        ),
                        ">();"
                    );
                });
                onFirst = false;
            }
            this.emitLine('else throw "Could not deserialize";');
        });
        this.ensureBlankLine();
        this.emitBlock(["inline void to_json(json& _j, const ", variantType, "& _x)"], false, () => {
            this.emitBlock("switch (_x.which())", false, () => {
                let i = 0;
                for (const t of nonNulls) {
                    this.emitLine("case ", i.toString(), ":");
                    this.indent(() => {
                        this.emitLine(
                            "_j = boost::get<",
                            this.cppType(
                                t,
                                {
                                    needsForwardIndirection: true,
                                    needsOptionalIndirection: true,
                                    inJsonNamespace: true
                                },
                                false
                            ),
                            ">(_x);"
                        );
                        this.emitLine("break;");
                    });
                    i++;
                }
                this.emitLine('default: throw "Input JSON does not conform to schema";');
            });
        });
    }

    protected emitEnumFunctions(e: EnumType, enumName: Name): void {
        const ourQualifier = this.ourQualifier(true);
        this.emitBlock(["inline void from_json(const json& _j, ", ourQualifier, enumName, "& _x)"], false, () => {
            let onFirst = true;
            this.forEachEnumCase(e, "none", (name, jsonName) => {
                const maybeElse = onFirst ? "" : "else ";
                this.emitLine(
                    maybeElse,
                    'if (_j == "',
                    stringEscape(jsonName),
                    '") _x = ',
                    ourQualifier,
                    enumName,
                    "::",
                    name,
                    ";"
                );
                onFirst = false;
            });
            this.emitLine('else throw "Input JSON does not conform to schema";');
        });
        this.ensureBlankLine();
        this.emitBlock(["inline void to_json(json& _j, const ", ourQualifier, enumName, "& _x)"], false, () => {
            this.emitBlock("switch (_x)", false, () => {
                this.forEachEnumCase(e, "none", (name, jsonName) => {
                    this.emitLine(
                        "case ",
                        ourQualifier,
                        enumName,
                        "::",
                        name,
                        ': _j = "',
                        stringEscape(jsonName),
                        '"; break;'
                    );
                });
                this.emitLine('default: throw "This should not happen";');
            });
        });
    }

    protected emitTopLevelTypedef(t: Type, name: Name): void {
        this.emitLine(
            "typedef ",
            this.cppType(
                t,
                { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: false },
                true
            ),
            " ",
            name,
            ";"
        );
    }

    protected emitAllUnionFunctions(): void {
        this.forEachUniqueUnion(
            "interposing",
            u =>
                this.sourcelikeToString(
                    this.cppTypeInOptional(
                        removeNullFromUnion(u, true)[1],
                        { needsForwardIndirection: false, needsOptionalIndirection: false, inJsonNamespace: true },
                        false
                    )
                ),
            (u: UnionType) => this.emitUnionFunctions(u)
        );
    }

    protected emitOptionalHelpers(): void {
        this.emitBlock([`template <typename T>\nstruct adl_serializer<${optionalType}<T>>`], true, () => {
            this.emitBlock([`static void to_json(json& j, const ${optionalType}<T>& opt)`], false, () => {
                this.emitLine(`if (!opt) j = nullptr; else j = *opt;`);
            });

            this.ensureBlankLine();

            this.emitBlock([`static ${optionalType}<T> from_json(const json& j)`], false, () => {
                this.emitLine(`return j.is_null() ? ${optionalType}<T>() : ${optionalType}<T>(new T(j.get<T>()));`);
            });
        });
    }

    protected emitDeclaration(decl: Declaration): void {
        if (decl.kind === "forward") {
            if (this._options.codeFormat) {
                this.emitLine("class ", this.nameForNamedType(decl.type), ";");
            } else {
                this.emitLine("struct ", this.nameForNamedType(decl.type), ";");
            }
        } else if (decl.kind === "define") {
            const t = decl.type;
            const name = this.nameForNamedType(t);
            if (t instanceof ClassType) {
                this.emitClass(t, name);
            } else if (t instanceof EnumType) {
                this.emitEnum(t, name);
            } else if (t instanceof UnionType) {
                this.emitUnionTypedefs(t, name);
            } else {
                return panic(`Cannot declare type ${t.kind}`);
            }
        } else {
            return assertNever(decl.kind);
        }
    }

    protected emitHelperFunctions(): void {
        this.emitBlock(["template <typename T>\nstd::string stringify(const T &t)"], false, () => {
            this.emitLine("std::stringstream ss;");
            this.emitLine("for (auto e : t) ss << e << \", \";");
            this.emitLine("ss << std::endl;");
            this.emitLine("return ss.str();");
        });

        this.ensureBlankLine();

        this.emitBlock(["template <typename Enumeration>\nauto as_integer(Enumeration const value)\n-> typename std::underlying_type<Enumeration>::type"], false, () => {
            this.emitLine("return static_cast<typename std::underlying_type<Enumeration>::type>(value);");
        });

        this.ensureBlankLine();

        this.emitBlock(["inline json get_untyped(const json &j, const char *property)"], false, () => {
            this.emitBlock(["if (j.find(property) != j.end())"], false, () => {
                this.emitLine("return j.at(property).get<json>();");
            });
            this.emitLine("return json();");
        });

        this.ensureBlankLine();

        if (this.haveUnions) {
            this.emitBlock([`template <typename T>\ninline ${optionalType}<T> get_optional(const json &j, const char *property)`], false, () => {
                this.emitBlock(["if (j.find(property) != j.end())"], false, () => {
                    this.emitLine(`return j.at(property).get<${optionalType}<T>>();`);
                });
                this.emitLine(`return ${optionalType}<T>();`);
            });

            this.ensureBlankLine();
        }
    }

    protected emitHelper(): void {
        this.startFile("helper.hpp", false);

        this.emitNamespaces(this._namespaceNames, () => {
            this.emitLine("using nlohmann::json;");

            this.forEachTopLevel(
                "leading",
                (t: Type, name: Name) => this.emitTopLevelTypedef(t, name),
                t => this.namedTypeToNameForTopLevel(t) === undefined
            );
            this.ensureBlankLine();

            this.emitHelperFunctions();
        });

        if (this.haveUnions) {
            this.emitNamespaces(["nlohmann"], () => {
                this.emitOptionalHelpers();
            });
        }

        this.finishFile();
    }

    protected emitTypes(): void {
        if (!this._options.justTypes) {
            this.emitLine("using nlohmann::json;");
            this.ensureBlankLine();
            this.emitHelperFunctions();
        }
        this.forEachDeclaration("interposing", decl => this.emitDeclaration(decl));
        if (this._options.justTypes) return;
        this.forEachTopLevel(
            "leading",
            (t: Type, name: Name) => this.emitTopLevelTypedef(t, name),
            t => this.namedTypeToNameForTopLevel(t) === undefined
        );
    }

    protected emitSingleSourceStructure(proposedFilename: string): void {
        this.startFile(proposedFilename);

        if (this._options.justTypes) {
            this.emitTypes();
        } else {
            this.emitNamespaces(this._namespaceNames, () => this.emitTypes());
        }

        if (!this._options.justTypes && this.haveNamedTypes) {
            this.ensureBlankLine();
            this.emitNamespaces(["nlohmann"], () => {
                if (this.haveUnions) {
                    this.emitOptionalHelpers();
                }
                this.forEachObject("leading-and-interposing", (c: ClassType, className: Name) =>
                    this.emitClassFunctions(c, className)
                );
                this.forEachEnum("leading-and-interposing", (e: EnumType, enumName: Name) =>
                    this.emitEnumFunctions(e, enumName)
                );
                if (this.haveUnions) {
                    this.ensureBlankLine();
                    this.emitAllUnionFunctions();
                }
            });
        }

        this.finishFile();
    }

    protected updateIncludes(includes: Set<string>, propertyType: Type): void {
        const propertyTypes = directlyReachableTypes<string>(propertyType, t => {
            if (isNamedType(t) &&
                (t instanceof ClassType ||
                 t instanceof EnumType ||
                 t instanceof UnionType)) {
                    return new Set([ this.sourcelikeToString(this.cppType(t, { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: false }, true)) ]);
                }

            return null;
        });

        /** 
         * Need to check which elements are included in _allTypeNames and
         * list them as includes
         */
        propertyTypes.forEach(pt => {
            this._allTypeNames.forEach(tt => {
                /** Please note that pt can be "std::unique_ptr<std::vector<Evolution>>" */
                if (pt.indexOf(tt) !== -1) {
                    includes.add(tt);
                }
            });
        });
    }

    protected emitIncludes(c: ClassType | UnionType): void {
        /** 
         * Need to generate "includes", in terms 'c' has members, which
         * are defined by others
         */
        let includes: Set<string> = new Set<string>();

        if (c instanceof UnionType) {
            const [, nonNulls] = removeNullFromUnion(c, true);
            if (nonNulls !== undefined) {
                for (const t of nonNulls) {
                    this.updateIncludes(includes, t);
                }
            }
        } else if (c instanceof ClassType) {
            this.forEachClassProperty(c, "none", (_name, _jsonName, property) => {
                this.updateIncludes(includes, property.type);
            });
        }

        if (includes.size !== 0) {
            includes.forEach(i => {
                const include = (name: string): void => {
                    this.emitLine(`#include ${name}`);
                };
                include("\""+i+".hpp\"");
            });

            this.ensureBlankLine();
        }
    }

    protected emitDefinition(d: ClassType | EnumType | UnionType, defName: Name): void {
        this.startFile(this.sourcelikeToString(defName)+".hpp");

        if (d instanceof ClassType || d instanceof UnionType) {
            this.emitIncludes(d);
        }

        this.emitNamespaces(this._namespaceNames, () => {
            this.ensureBlankLine();
            this.emitDescription(this.descriptionForType(d));
            this.ensureBlankLine();
            this.emitLine("using nlohmann::json;");
            this.ensureBlankLine();
            if (d instanceof ClassType) {
                this.emitClass(d, defName);
            } else if (d instanceof EnumType) {
                this.emitEnum(d, defName);
            } else if (d instanceof UnionType) {
                this.emitUnionTypedefs(d, defName);
            }
        });

        this.emitNamespaces(["nlohmann"], () => {
            if (d instanceof ClassType) {
                this.emitClassFunctions(d, defName);
            } else if (d instanceof EnumType) {
                this.emitEnumFunctions(d, defName);
            } else if (d instanceof UnionType) {
                this.emitUnionFunctions(d);
            }
        });

        this.finishFile();
    }

    protected emitMultiSourceStructure(proposedFilename: string): void {
        this.emitHelper();

        this.forEachNamedType(
            "leading-and-interposing",
            (c: ClassType, n: Name) => this.emitDefinition(c, n),
            (e, n) => this.emitDefinition(e, n),
            (u, n) => this.emitDefinition(u, n)
        );

        /**
         * Quite a hack, this is ONLY to satisfy the test subsystem, which
         * explicitly looks for a Toplevel.hpp
         */
        if (this._allTypeNames.size === 0) {
            this.startFile(proposedFilename);
            this.finishFile();
        }
    }

    protected emitSourceStructure(proposedFilename: string): void {
        /** Gather all the unique/custom types used by the schema */
        this.forEachDeclaration("none", decl => {
            const definedTypes = directlyReachableTypes<string>(decl.type, t => {
                if (isNamedType(t) &&
                    (t instanceof ClassType ||
                     t instanceof EnumType ||
                     t instanceof UnionType)) {
                    return new Set([ this.sourcelikeToString(this.cppType(t, { needsForwardIndirection: true, needsOptionalIndirection: true, inJsonNamespace: false }, true)) ]);
                }

                return null;
            });

            this._allTypeNames = setUnion(definedTypes, this._allTypeNames);
        });

        if (this._options.typeSourceStyle) {
            this.emitSingleSourceStructure(proposedFilename);
        } else {
            this.emitMultiSourceStructure(proposedFilename);
        }
    }
}
