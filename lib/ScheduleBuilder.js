"use strict";
/* -------------------------------------------------------------------
 * Require Statements << Keep in alphabetical order >>
 * ---------------------------------------------------------------- */

var Argument = require('./Argument');
var Common = require('./Common');
var Range = require('./Range');
var RuleGroup = require('./RuleGroup');
var Token = require('./Token');

/* =============================================================================
 * 
 * ScheduleBuilder Class
 * 
 * For parsing the schedule syntax.
 *  
 * ========================================================================== */

module.exports = ScheduleBuilder;

function ScheduleBuilder (str)
{
	/** @type {string} */
	this.text = str;
	/** @type {Token[]} */
	this.tokens = [];
	this.ast = [];
}

/* -------------------------------------------------------------------
 * Public Methods << Keep in alphabetical order >>
 * ---------------------------------------------------------------- */

ScheduleBuilder.prototype.buildAbstractSyntaxTree = function ()
{
	var i = 0;
	while (i < this.tokens.length)
	{
		// check token type
		if (this.tokens[i].isExpression)
		{
			// token is a keyword/expression
			i = this.buildExpression(i, this.ast);
		}
		else
		{
			// commas between top-level expressions are optional. No other special tokens are allowed.
			if (i > 0 && this.tokens[i].value === ',')
			{
				i++;
				continue;
			}
			
			// can't have a special token or number outside of a expression
			throw this.syntaxError('Unexpected token. Expected a expression.', this.tokens[i]);
		}
	}
};

/**
 * @param i {number}
 * @param context {Array}
 * @returns {number}
 */
ScheduleBuilder.prototype.buildArgument = function (i, context)
{
	var _this = this;
	var tokens = this.tokens;
	var t = tokens[i];
	this.ensureToken(t);
	var firstToken = t;

	if (!t)
		return i; // let the expression handle this syntax error
	
	function parseNumber ()
	{
		var negative = false;
		if (t.isSpecial)
		{
			if (t.value === '-')
			{
				negative = true;
				t = tokens[++i];
			}
			else
			{
				throw _this.syntaxError('Unexpected token in argument.', t);
			}
		}

		var num = Number(t.value);
		if (isNaN(num))
			throw _this.syntaxError('Unknown argument syntax. Expected a number.', t);

		if (negative)
			num *= -1;

		t = tokens[++i];
		_this.ensureToken(t);
		return num;
	}
	
	function parseNumberOrDate ()
	{
		var num = parseNumber();
		
		if (t.value !== '/')
			return num;

		// argument is a date or date range
		var month = num;
		var day;
		if (month < 1 || month > 12)
			throw _this.syntaxError('Invalid Month', firstToken);
		
		t = tokens[++i];
		_this.ensureToken(t);
		day = parseNumber();
		if (day < 1 || day > Common.daysInMonth(month - 1))
			throw _this.syntaxError('Invalid Date', firstToken);
		
		return new Range(month, day);
	}

	var type, value;
	var mod = null;
	var isExclude = false;
	
	if (t.value === '!')
	{
		isExclude = true;
		t = tokens[++i];
		this.ensureToken(t);
	}
	
	if (t.isSpecial)
	{
		if (t.value === ')')
			return i;

		if (t.value === ',')
			throw this.syntaxError('Empty argument', t);
	}

	// check for argument type
	if (t.isExpression)
	{
		// expression can't be preceded by a minus or !
		if (isExclude)
			throw this.syntaxError('Unexpected token in argument.', tokens[i - 1]);
		
		return this.buildExpression(i, context);
	}
	
	var low, high;
	var isDay = false;
	var isDate = false;
	if (t.value === '%')
	{
		type = 'wildcard';
		value = null;
	}
	else
	{
		if (t.isDayKeyword)
		{
			isDay = true;
			low = t.toDayOfWeek();
			t = tokens[++i];
			this.ensureToken(t);
		}
		else // argument should be a number, range, and/or date
		{
			low = parseNumberOrDate();
			if (low instanceof Range)
				isDate = true;
		}

		// check for range
		if (t.value === '-')
		{
			t = tokens[++i];
			this.ensureToken(t);

			if (t.isDayKeyword && !isDate)
			{
				isDay = true;
				high = t.toDayOfWeek();
				t = tokens[++i];
			}
			else
			{
				high = parseNumberOrDate();
				if ((isDate && !(high instanceof Range)) || (!isDate && high instanceof Range))
					throw this.syntaxError('Cannot mix numeric and date ranges.', firstToken);

				type = isDate ? 'dates' : 'range';
			}

			if (isDay)
				type = 'days';

			value = new Range(low, high);
		}
		else if (isDate)
		{
			type = 'dates';
			value = new Range(low, low);
		}
		else if (isDay)
		{
			type = 'days';
			value = new Range(low, low);
		}
		else
		{
			// just a plain ole number
			type = 'number';
			value = low;
		}
	}
	
	//check for a modulus component
	if (t.value === '%')
	{
		t = tokens[++i];
		this.ensureToken(t);
		mod = parseNumber();
	}

	context.push(new Argument(type, value, isExclude, mod, firstToken));

	return i;
};

/**
 * @param i {number}
 * @param context {Array}
 * @returns {number}
 */
ScheduleBuilder.prototype.buildExpression = function (i, context)
{
	var start = i;
	var tokens = this.tokens;

	var cmd = {
		type: "expression",
		name: tokens[i].value,
		arguments: [],
		firstToken: tokens[i]
	};

	i++;
	if (i >= tokens.length)
	{
		throw this.syntaxError('Expression has no opening parenthesis.', tokens[i - 1]);
	}

	if (tokens[i].value !== '(')
	{
		throw this.syntaxError('Unexpected an opening parenthesis.', tokens[i]);
	}

	// get the expression's arguments
	i++;
	while (tokens[i])
	{
		if (tokens[i].value === ')')
			break;

		i = this.buildArgument(i, cmd.arguments);
		if (tokens[i] && tokens[i].value === ',')
			i++;
	}

	if (!tokens[i] || tokens[i].value !== ')')
		throw this.syntaxError('Expression is missing a closing parenthesis.', tokens[start]);

	context.push(cmd);
	return i + 1;
};

/**
 * @returns {RuleGroup[]}
 */
ScheduleBuilder.prototype.compile = function ()
{
	var rules = [];
	var globalExpressions = [];
	var ast = this.ast;
	var cmd, rule;
	
	for (var i = 0; i < ast.length; i++)
	{
		cmd = ast[i];
		if (cmd.type !== 'expression')
		{
			throw this.syntaxError('Syntax Tree is invalid. Top-level item is not a expression.', cmd.firstToken);
		}
		
		if (cmd.name === 'group')
		{
			rule = this.compileGroup(cmd.arguments);
			if (rule === null)
				throw this.syntaxError('No rules in schedule.', cmd.firstToken);
			
			rules.push(rule);
		}
		else
		{
			// top level expressions go into an implicit group
			globalExpressions.push(cmd);
		}
	}
	
	if (globalExpressions.length > 0)
	{
		rule = this.compileGroup(globalExpressions);
		if (rule === null)
			throw this.syntaxError('No rules in schedule.', globalExpressions[i].firstToken);
		
		rules.push(rule);
	}
	
	return rules;
};

ScheduleBuilder.prototype.compileGroup = function (expressions)
{
	var rule = new RuleGroup();
	
	/** @type {Argument} */
	var arg;
	var cmd, name, x, args, propType, prop, max, min, low, high, split;
	var somethingSet = false;
	for (var i = 0; i < expressions.length; i++)
	{
		cmd = expressions[i];
		if (!cmd || cmd.type !== 'expression')
		{
			throw this.syntaxError('Expected a expression argument.', cmd.firstToken);
		}
		
		name = cmd.name.toLowerCase();
		
		switch (name)
		{
			case 's':
			case 'sec':
			case 'second':
			case 'seconds':
			case 'secondofminute':
			case 'secondsofminute':
				propType = 'seconds';
				min = 0;
				max = 59;
				break;
			case 'm':
			case 'min':
			case 'minute':
			case 'minutes':
			case 'minuteofhour':
			case 'minutesofhour':
				propType = 'minutes';
				min = 0;
				max = 59;
				break;
			case 'h':
			case 'hour':
			case 'hours':
			case 'hourofday':
			case 'hoursofday':
				propType = 'hours';
				min = 0;
				max = 23;
				break;
			case 'day':
			case 'days':
			case 'dow':
			case 'dayofweek':
			case 'daysofweek':
				propType = 'daysOfWeek';
				min = 1;
				max = 7;
				break;
			case 'dom':
			case 'dayofmonth':
			case 'daysofmonth':
				propType = 'daysOfMonth';
				min = -31;
				max = 31;
				break;
			case 'date':
			case 'dates':
				propType = 'dates';
				min = 1;
				max = 31;
				break;
			default:
				throw this.syntaxError('Unknown expression ' + cmd.name, cmd.firstToken);
		}
		
		args = cmd.arguments.slice();
		if (args.length === 0)
		{
			if (propType === 'dates')
			{
				somethingSet = true;
			}
			else
			{
				args.push(new Argument('range', new Range(min, max), false, null, cmd.firstToken));
			}
		}

		// normalize and validate the expression arguments
		for (x = 0; x < args.length; x++)
		{
			split = false;
			arg = args[x];
			if (propType === 'dates')
			{
				if (arg.type === 'wildcard')
				{
					low = new Range(1, 1);
					high = new Range(12, 31);
				}
				if (arg.type === 'dates')
				{
					low = arg.value.low.copy();
					high = arg.value.high.copy();

					low.month |= 0;
					low.day |= 0;
					high.month |= 0;
					high.day |= 0;

					// the dates were already validated by the parser, now we just need to check to see if the range spans across January 1st.
					if (low.month >= high.month &&
						(low.month > high.month || low.day > high.day))
					{
						split = true;
					}
				}
				else
				{
					throw this.syntaxError('Invalid argument. Expected a date.', arg.firstToken);
				}
				
				// JavaScript months are zero-indexed
				low.month--;
				high.month--;
			}
			else if (arg.type === 'wildcard')
			{
				low = propType === 'daysOfMonth' ? 1 : min;
				high = max;
			}
			else if (arg.type !== 'number' && (arg.type === 'days' || propType === 'daysOfWeek'))
			{
				if (propType !== 'daysOfWeek')
					throw this.syntaxError('Weekday names can only be used inside daysOfWeek expressions.', arg.firstToken);
				
				if (arg.type !== 'days' && arg.type !== 'range')
					throw this.syntaxError('Invalid argument in ' + name + ' expression.', arg.firstToken);
				
				low = arg.value.low | 0;
				high = arg.value.high | 0;
				
				if (high < low) // the day range spans a sat/sun boundary
					split = true;
				else if (arg.modulus && high === low)
					high = max;
			}
			else if (arg.type === 'number')
			{
				high = low = arg.value | 0;
				if (arg.modulus)
					high = max;
			}
			else if (arg.type === 'range')
			{
				low = arg.value.low | 0;
				high = arg.value.high | 0;

				// low cannot be greater than high, unless high is a negative and low is positive.
				// Negative numbers are considered higher than positive since they count from the back of an interval.
				if (low > high && !(low >= 0 && high < 0))
				{
					split = true;
				}
			}
			else
			{
				throw this.syntaxError('Invalid Argument', arg.firstToken);
			}

			if (propType !== 'dates') // dates have already been validated by the parser
			{
				if (low < min || high < min)
					throw this.syntaxError('Minimum ' + propType + ' value is ' + min, arg.firstToken);

				if (high > max || low > max)
					throw this.syntaxError('Maximum ' + propType + ' value is ' + max, arg.firstToken);

				if (propType === 'daysOfMonth' && (low === 0 || high === 0))
					throw this.syntaxError('Day of month cannot be zero.', arg.firstToken);

				if (propType === 'daysOfWeek')
				{
					// JavaScript weekdays start at zero
					low--;
					high--;
				}
			}
			
			if (arg.modulus < 0)
				throw this.syntaxError('Modulus value cannot be negative.', arg.firstToken);
			
			prop = arg.isExclude ? propType + 'Exclude' : propType;
			if (!rule[prop])
				rule[prop] = [];
			
			rule[prop].push(new Range(low, high, split, arg.modulus));
			somethingSet = true;
		}
	}
	
	if (!somethingSet)
		return null;
	
	// setup implied values
	if (rule.seconds || rule.secondsExclude)
	{
		// don't need to setup any defaults if seconds are defined
	}
	else if (rule.minutes || rule.minutesExclude)
	{
		rule.seconds = [new Range(0, 0)];
	}
	else if (rule.hours || rule.hoursExclude)
	{
		rule.seconds = [new Range(0, 0)];
		rule.minutes = [new Range(0, 0)];
	}
	else // only a date level expression was set
	{
		rule.seconds = [new Range(0, 0)];
		rule.minutes = [new Range(0, 0)];
		rule.hours = [new Range(0, 0)];
	}
	
	return rule;
};

ScheduleBuilder.prototype.ensureToken = function (token)
{
	if (!token)
		throw this.syntaxError('Unexpected end of format string.', this.tokens[this.tokens.length - 1]);
};

/**
 * @param message {string}
 * @param token {Token}
 * @returns {SyntaxError}
 */
ScheduleBuilder.prototype.syntaxError = function (message, token)
{
	var startIndex = Math.max(token.index - 10, 0);
	var endIndex = Math.min(token.index + token.value.length + 20, this.text.length);

	var sub = this.text.substring(startIndex, endIndex);
	var pointer = '';
	for (var i = startIndex; i < endIndex; i++)
	{
		pointer += i === token.index ? '^' : ' ';
	}

	return new SyntaxError(message + '\n    ' + sub + '\n    ' + pointer);
};

ScheduleBuilder.prototype.tokenize = function ()
{
	var str = this.text;
	var token = new Token(0);
	var tokens = this.tokens;
	for (var i = 0; i < str.length; i++)
	{
		switch (str[i])
		{
			case ' ':
			case '\t':
			case '\n':
			case '\r':
				if (token.value)
					tokens.push(token);
				token = new Token(i + 1);
				break;
			case '(':
			case ')':
			case '-':
			case ',':
			case '!':
			case '/':
			case '%':
				if (token.value)
					tokens.push(token);
				tokens.push(new Token(i, str[i]));
				token = new Token(i + 1);
				break;
			default:
				token.value += str[i];
				break;
		}
	}

	if (token.value)
		tokens.push(token);
};

