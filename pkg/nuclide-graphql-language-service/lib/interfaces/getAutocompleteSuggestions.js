/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * @flow
 * @format
 */

import type {
  FragmentDefinitionNode,
  GraphQLDirective,
  GraphQLSchema,
} from 'graphql';
import type {
  AutocompleteSuggestionType,
  ContextToken,
  State,
  TypeInfo,
} from '../types/Types';
import type {Point} from '../utils/Range';

import {
  isInputType,
  isCompositeType,
  isAbstractType,
  getNullableType,
  getNamedType,
  GraphQLEnumType,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLBoolean,
  doTypesOverlap,
} from 'graphql';
import {
  SchemaMetaFieldDef,
  TypeMetaFieldDef,
  TypeNameMetaFieldDef,
} from 'graphql/type/introspection';
import {
  forEachState,
  getDefinitionState,
  getFieldDef,
  hintList,
  objectValues,
} from './autocompleteUtils';
import CharacterStream from '../parser/CharacterStream';
import onlineParser from '../parser/onlineParser';

/**
 * Given GraphQLSchema, queryText, and context of the current position within
 * the source text, provide a list of typeahead entries.
 */

export function getAutocompleteSuggestions(
  schema: GraphQLSchema,
  queryText: string,
  cursor: Point,
): Array<AutocompleteSuggestionType> {
  const token = getTokenAtPosition(queryText, cursor);

  const state = token.state.kind === 'Invalid'
    ? token.state.prevState
    : token.state;

  // relieve flow errors by checking if `state` exists
  if (!state) {
    return [];
  }

  const kind = state.kind;
  const step = state.step;
  const typeInfo = getTypeInfo(schema, token.state);

  // Definition kinds
  if (kind === 'Document') {
    return hintList(cursor, token, [
      {text: 'query'},
      {text: 'mutation'},
      {text: 'subscription'},
      {text: 'fragment'},
      {text: '{'},
    ]);
  }

  // Field names
  if (kind === 'SelectionSet' || kind === 'Field' || kind === 'AliasedField') {
    return getSuggestionsForFieldNames(cursor, token, typeInfo, schema);
  }

  // Argument names
  if (kind === 'Arguments' || (kind === 'Argument' && step === 0)) {
    const argDefs = typeInfo.argDefs;
    if (argDefs) {
      return hintList(
        cursor,
        token,
        argDefs.map(argDef => ({
          text: argDef.name,
          type: argDef.type,
          description: argDef.description,
        })),
      );
    }
  }

  // Input Object fields
  if (kind === 'ObjectValue' || (kind === 'ObjectField' && step === 0)) {
    if (typeInfo.objectFieldDefs) {
      const objectFields = objectValues(typeInfo.objectFieldDefs);
      return hintList(
        cursor,
        token,
        objectFields.map(field => ({
          text: field.name,
          type: field.type,
          description: field.description,
        })),
      );
    }
  }

  // Input values: Enum and Boolean
  if (
    kind === 'EnumValue' ||
    (kind === 'ListValue' && step === 1) ||
    (kind === 'ObjectField' && step === 2) ||
    (kind === 'Argument' && step === 2)
  ) {
    return getSuggestionsForInputValues(cursor, token, typeInfo);
  }

  // Fragment type conditions
  if (
    (kind === 'TypeCondition' && step === 1) ||
    (kind === 'NamedType' &&
      state.prevState != null &&
      state.prevState.kind === 'TypeCondition')
  ) {
    return getSuggestionsForFragmentTypeConditions(
      cursor,
      token,
      typeInfo,
      schema,
    );
  }

  // Fragment spread names
  if (kind === 'FragmentSpread' && step === 1) {
    return getSuggestionsForFragmentSpread(
      cursor,
      token,
      typeInfo,
      schema,
      queryText,
    );
  }

  // Variable definition types
  if (
    (kind === 'VariableDefinition' && step === 2) ||
    (kind === 'ListType' && step === 1) ||
    (kind === 'NamedType' &&
      state.prevState &&
      (state.prevState.kind === 'VariableDefinition' ||
        state.prevState.kind === 'ListType'))
  ) {
    return getSuggestionsForVariableDefinition(cursor, token, schema);
  }

  // Directive names
  if (kind === 'Directive') {
    return getSuggestionsForDirective(cursor, token, state, schema);
  }

  return [];
}

// Helper functions to get suggestions for each kinds
function getSuggestionsForFieldNames(
  cursor: Point,
  token: ContextToken,
  typeInfo: TypeInfo,
  schema: GraphQLSchema,
): Array<AutocompleteSuggestionType> {
  if (typeInfo.parentType) {
    const parentType = typeInfo.parentType;
    const fields = parentType.getFields instanceof Function
      ? objectValues(parentType.getFields())
      : [];
    if (isAbstractType(parentType)) {
      fields.push(TypeNameMetaFieldDef);
    }
    if (parentType === schema.getQueryType()) {
      fields.push(SchemaMetaFieldDef, TypeMetaFieldDef);
    }
    return hintList(
      cursor,
      token,
      fields.map(field => ({
        text: field.name,
        type: field.type,
        description: field.description,
        isDeprecated: field.isDeprecated,
        deprecationReason: field.deprecationReason,
      })),
    );
  }
  return [];
}

function getSuggestionsForInputValues(
  cursor: Point,
  token: ContextToken,
  typeInfo: TypeInfo,
): Array<AutocompleteSuggestionType> {
  const namedInputType = getNamedType(typeInfo.inputType);
  if (namedInputType instanceof GraphQLEnumType) {
    const values = namedInputType.getValues();
    return hintList(
      cursor,
      token,
      values.map(value => ({
        text: value.name,
        type: namedInputType,
        description: value.description,
        isDeprecated: value.isDeprecated,
        deprecationReason: value.deprecationReason,
      })),
    );
  } else if (namedInputType === GraphQLBoolean) {
    return hintList(cursor, token, [
      {text: 'true', type: GraphQLBoolean, description: 'Not false.'},
      {text: 'false', type: GraphQLBoolean, description: 'Not true.'},
    ]);
  }

  return [];
}

function getSuggestionsForFragmentTypeConditions(
  cursor: Point,
  token: ContextToken,
  typeInfo: TypeInfo,
  schema: GraphQLSchema,
): Array<AutocompleteSuggestionType> {
  let possibleTypes;
  if (typeInfo.parentType) {
    if (isAbstractType(typeInfo.parentType)) {
      // Collect both the possible Object types as well as the interfaces
      // they implement.
      const possibleObjTypes = schema.getPossibleTypes(typeInfo.parentType);
      const possibleIfaceMap = Object.create(null);
      possibleObjTypes.forEach(type => {
        type.getInterfaces().forEach(iface => {
          possibleIfaceMap[iface.name] = iface;
        });
      });
      possibleTypes = possibleObjTypes.concat(objectValues(possibleIfaceMap));
    } else {
      // The parent type is a non-abstract Object type, so the only possible
      // type that can be used is that same type.
      possibleTypes = [typeInfo.parentType];
    }
  } else {
    const typeMap = schema.getTypeMap();
    possibleTypes = objectValues(typeMap).filter(isCompositeType);
  }
  return hintList(
    cursor,
    token,
    possibleTypes.map(type => {
      const namedType = getNamedType(type);
      return {
        text: String(type),
        description: (namedType && namedType.description) || '',
      };
    }),
  );
}

function getSuggestionsForFragmentSpread(
  cursor: Point,
  token: ContextToken,
  typeInfo: TypeInfo,
  schema: GraphQLSchema,
  queryText: string,
): Array<AutocompleteSuggestionType> {
  const typeMap = schema.getTypeMap();
  const defState = getDefinitionState(token.state);
  const fragments = getFragmentDefinitions(queryText);

  // Filter down to only the fragments which may exist here.
  const relevantFrags = fragments.filter(
    frag =>
      // Only include fragments with known types.
      typeMap[frag.typeCondition.name.value] &&
      // Only include fragments which are not cyclic.
      !(defState &&
        defState.kind === 'FragmentDefinition' &&
        defState.name === frag.name.value) &&
      // Only include fragments which could possibly be spread here.
      isCompositeType(typeInfo.parentType) &&
      isCompositeType(typeMap[frag.typeCondition.name.value]) &&
      doTypesOverlap(
        schema,
        typeInfo.parentType,
        typeMap[frag.typeCondition.name.value],
      ),
  );

  return hintList(
    cursor,
    token,
    relevantFrags.map(frag => ({
      text: frag.name.value,
      type: typeMap[frag.typeCondition.name.value],
      description: `fragment ${frag.name.value} on ${frag.typeCondition.name.value}`,
    })),
  );
}

function getFragmentDefinitions(
  queryText: string,
): Array<FragmentDefinitionNode> {
  const fragmentDefs = [];
  runOnlineParser(queryText, (_, state) => {
    if (state.kind === 'FragmentDefinition' && state.name && state.type) {
      fragmentDefs.push({
        kind: 'FragmentDefinition',
        name: {
          kind: 'Name',
          value: state.name,
        },
        selectionSet: {
          kind: 'SelectionSet',
          selections: [],
        },
        typeCondition: {
          kind: 'NamedType',
          name: {
            kind: 'Name',
            value: state.type,
          },
        },
      });
    }
  });

  return fragmentDefs;
}

function getSuggestionsForVariableDefinition(
  cursor: Point,
  token: ContextToken,
  schema: GraphQLSchema,
): Array<AutocompleteSuggestionType> {
  const inputTypeMap = schema.getTypeMap();
  const inputTypes = objectValues(inputTypeMap).filter(isInputType);
  return hintList(
    cursor,
    token,
    inputTypes.map(type => ({
      text: type.name,
      description: type.description,
    })),
  );
}

function getSuggestionsForDirective(
  cursor: Point,
  token: ContextToken,
  state: State,
  schema: GraphQLSchema,
): Array<AutocompleteSuggestionType> {
  if (state.prevState && state.prevState.kind) {
    const stateKind = state.prevState.kind;
    const directives = schema
      .getDirectives()
      .filter(directive => canUseDirective(stateKind, directive));
    return hintList(
      cursor,
      token,
      directives.map(directive => ({
        text: directive.name,
        description: directive.description,
      })),
    );
  }
  return [];
}

function getTokenAtPosition(queryText: string, cursor: Point): ContextToken {
  let styleAtCursor = null;
  let stateAtCursor = null;
  let stringAtCursor = null;
  const token = runOnlineParser(queryText, (stream, state, style, index) => {
    if (index === cursor.row) {
      if (stream.getCurrentPosition() > cursor.column) {
        return 'BREAK';
      }
      styleAtCursor = style;
      stateAtCursor = {...state};
      stringAtCursor = stream.current();
    }
  });

  // Return the state/style of parsed token in case those at cursor aren't
  // available.
  return {
    start: token.start,
    end: token.end,
    string: stringAtCursor || token.string,
    state: stateAtCursor || token.state,
    style: styleAtCursor || token.style,
  };
}

/**
 * Provides an utility function to parse a given query text and construct a
 * `token` context object.
 * A token context provides useful information about the token/style that
 * CharacterStream currently possesses, as well as the end state and style
 * of the token.
 */
type callbackFnType = (
  stream: CharacterStream,
  state: State,
  style: string,
  index: number,
) => void | 'BREAK';

function runOnlineParser(
  queryText: string,
  callback: callbackFnType,
): ContextToken {
  const lines = queryText.split('\n');
  const parser = onlineParser();
  let state = parser.startState();
  let style = '';

  let stream: CharacterStream = new CharacterStream('');

  for (let i = 0; i < lines.length; i++) {
    stream = new CharacterStream(lines[i]);
    // Stop the parsing when the stream arrives at the current cursor position
    while (!stream.eol()) {
      style = parser.token(stream, state);
      const code = callback(stream, state, style, i);
      if (code === 'BREAK') {
        break;
      }
    }

    if (!state.kind) {
      state = parser.startState();
    }
  }

  return {
    start: stream.getStartOfToken(),
    end: stream.getCurrentPosition(),
    string: stream.current(),
    state,
    style,
  };
}

function canUseDirective(kind: string, directive: GraphQLDirective): boolean {
  const locations = directive.locations;
  switch (kind) {
    case 'Query':
      return locations.indexOf('QUERY') !== -1;
    case 'Mutation':
      return locations.indexOf('MUTATION') !== -1;
    case 'Subscription':
      return locations.indexOf('SUBSCRIPTION') !== -1;
    case 'Field':
    case 'AliasedField':
      return locations.indexOf('FIELD') !== -1;
    case 'FragmentDefinition':
      return locations.indexOf('FRAGMENT_DEFINITION') !== -1;
    case 'FragmentSpread':
      return locations.indexOf('FRAGMENT_SPREAD') !== -1;
    case 'InlineFragment':
      return locations.indexOf('INLINE_FRAGMENT') !== -1;
  }
  return false;
}

// Utility for collecting rich type information given any token's state
// from the graphql-mode parser.
function getTypeInfo(schema: GraphQLSchema, tokenState: State): TypeInfo {
  let type;
  let parentType;
  let inputType;
  let directiveDef;
  let enumValue;
  let fieldDef;
  let argDef;
  let argDefs;
  let objectFieldDefs;

  forEachState(tokenState, state => {
    switch (state.kind) {
      case 'Query':
      case 'ShortQuery':
        type = schema.getQueryType();
        break;
      case 'Mutation':
        type = schema.getMutationType();
        break;
      case 'Subscription':
        type = schema.getSubscriptionType();
        break;
      case 'InlineFragment':
      case 'FragmentDefinition':
        if (state.type) {
          type = schema.getType(state.type);
        }
        break;
      case 'Field':
      case 'AliasedField':
        if (!type || !state.name) {
          fieldDef = null;
        } else {
          fieldDef = parentType
            ? getFieldDef(schema, parentType, state.name)
            : null;
          type = fieldDef ? fieldDef.type : null;
        }
        break;
      case 'SelectionSet':
        parentType = getNamedType(type);
        break;
      case 'Directive':
        directiveDef = state.name ? schema.getDirective(state.name) : null;
        break;
      case 'Arguments':
        if (!state.prevState) {
          argDefs = null;
        } else {
          switch (state.prevState.kind) {
            case 'Field':
              argDefs = fieldDef && fieldDef.args;
              break;
            case 'Directive':
              argDefs = directiveDef && directiveDef.args;
              break;
            case 'AliasedField':
              const name = state.prevState && state.prevState.name;
              if (!name) {
                argDefs = null;
                break;
              }
              const field = parentType
                ? getFieldDef(schema, parentType, name)
                : null;
              if (!field) {
                argDefs = null;
                break;
              }
              argDefs = field.args;
              break;
            default:
              argDefs = null;
              break;
          }
        }
        break;
      case 'Argument':
        if (argDefs) {
          for (let i = 0; i < argDefs.length; i++) {
            if (argDefs[i].name === state.name) {
              argDef = argDefs[i];
              break;
            }
          }
        }
        inputType = argDef && argDef.type;
        break;
      case 'EnumValue':
        const enumType = getNamedType(inputType);
        enumValue = enumType instanceof GraphQLEnumType
          ? find(enumType.getValues(), val => val.value === state.name)
          : null;
        break;
      case 'ListValue':
        const nullableType = getNullableType(inputType);
        inputType = nullableType instanceof GraphQLList
          ? nullableType.ofType
          : null;
        break;
      case 'ObjectValue':
        const objectType = getNamedType(inputType);
        objectFieldDefs = objectType instanceof GraphQLInputObjectType
          ? objectType.getFields()
          : null;
        break;
      case 'ObjectField':
        const objectField = state.name && objectFieldDefs
          ? objectFieldDefs[state.name]
          : null;
        inputType = objectField && objectField.type;
        break;
      case 'NamedType':
        if (state.name) {
          type = schema.getType(state.name);
        }
        break;
    }
  });

  return {
    type,
    parentType,
    inputType,
    directiveDef,
    enumValue,
    fieldDef,
    argDef,
    argDefs,
    objectFieldDefs,
  };
}

// Returns the first item in the array which causes predicate to return truthy.
function find(array, predicate) {
  for (let i = 0; i < array.length; i++) {
    if (predicate(array[i])) {
      return array[i];
    }
  }
  return null;
}
