(function_declaration
  name: (identifier) @definition.name) @definition

(variable_declarator
  name: (identifier) @definition.name
  value: [(arrow_function) (function_expression)] @definition)

(method_definition
  name: [(property_identifier) (private_property_identifier)] @definition.name) @definition

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call
