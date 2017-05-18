'use strict';

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.CodeSnippet = undefined;

var _AtomInput;

function _load_AtomInput() {
  return _AtomInput = require('./AtomInput');
}

var _react = _interopRequireDefault(require('react'));

function _interopRequireDefault(obj) { return obj && obj.__esModule ? obj : { default: obj }; }

/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the license found in the LICENSE file in
 * the root directory of this source tree.
 *
 * 
 * @format
 */

class CodeSnippet extends _react.default.Component {

  componentDidMount() {
    const editor = this.refs.editor.getTextEditor();
    const { grammar, highlights, startLine } = this.props;

    if (grammar) {
      editor.setGrammar(grammar);
    }

    if (highlights != null) {
      highlights.forEach(range => {
        const marker = editor.markBufferRange([[range.start.row - startLine, range.start.column], [range.end.row - startLine, range.end.column]]);
        editor.decorateMarker(marker, {
          type: 'highlight',
          class: 'code-snippet-highlight'
        });
      });

      // Make sure at least one highlight is visible.
      if (highlights.length > 0) {
        editor.scrollToBufferPosition([highlights[0].end.row - startLine + 1, highlights[0].end.column]);
      }
    }
  }

  render() {
    const lineNumbers = [];
    for (let i = this.props.startLine; i <= this.props.endLine; i++) {
      lineNumbers.push(_react.default.createElement(
        'div',
        {
          key: i,
          className: 'nuclide-ui-code-snippet-line-number',
          onClick: evt => this.props.onLineClick(evt, i) },
        i + 1
      ));
    }
    return _react.default.createElement(
      'div',
      { className: 'nuclide-ui-code-snippet' },
      _react.default.createElement(
        'div',
        { className: 'nuclide-ui-code-snippet-line-number-column' },
        lineNumbers
      ),
      _react.default.createElement((_AtomInput || _load_AtomInput()).AtomInput, {
        ref: 'editor',
        initialValue: this.props.text,
        disabled: true,
        onClick: this.props.onClick
      })
    );
  }
}
exports.CodeSnippet = CodeSnippet;