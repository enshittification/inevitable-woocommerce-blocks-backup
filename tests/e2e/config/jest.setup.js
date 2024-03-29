/* eslint-disable no-unused-vars */
/**
 * External dependencies
 */
import {
	enablePageDialogAccept,
	isOfflineMode,
	setBrowserViewport,
	switchUserToAdmin,
	switchUserToTest,
	visitAdminPage,
} from '@wordpress/e2e-test-utils';
import { setDefaultOptions } from 'expect-puppeteer';
import { get } from 'lodash';

/**
 * Internal dependencies
 */
import { DEFAULT_TIMEOUT } from '../utils';
// Set the default test timeout.
jest.setTimeout( 120000 );
// Retry failed tests at most 2 times in CI.
// This enables `flaky-tests-reporter` and `report-flaky-tests` GitHub action
// to mark test as flaky and automatically create a tracking issue about it.
if ( process.env.CI ) {
	jest.retryTimes( 2 );
}

setDefaultOptions( { timeout: DEFAULT_TIMEOUT } );

/**
 * Array of page event tuples of [ eventName, handler ].
 *
 * @type {Array}
 */
const pageEvents = [];
/**
 * Set of console logging types observed to protect against unexpected yet
 * handled (i.e. not catastrophic) errors or warnings. Each key corresponds
 * to the Puppeteer ConsoleMessage type, its value the corresponding function
 * on the console global object.
 *
 * @type {Object<string,string>}
 */
const OBSERVED_CONSOLE_MESSAGE_TYPES = {
	error: 'error',
};
async function setupBrowser() {
	await setBrowserViewport( 'large' );
}

/**
 * Navigates to WooCommerce's import page and imports sample products.
 *
 * @return {Promise} Promise resolving once products have been imported.
 */
async function importSampleProducts() {
	await switchUserToAdmin();
	// Visit `/wp-admin/edit.php?post_type=product` so we can see a list of products and decide if we should import them or not.
	await visitAdminPage( 'edit.php', 'post_type=product' );
	const emptyState = await page.evaluate( () =>
		window.find( 'Ready to start selling something awesome' )
	);
	const noProduct = await page.evaluate( () =>
		window.find( 'No products found' )
	);
	if ( emptyState || noProduct ) {
		// Visit Import Products page.
		await visitAdminPage(
			'edit.php',
			'post_type=product&page=product_importer'
		);
		await page.click( 'a.woocommerce-importer-toggle-advanced-options' );
		await page.focus( '#woocommerce-importer-file-url' );
		// local path for sample data that is included with woo.
		await page.keyboard.type(
			'wp-content/plugins/woocommerce/sample-data/sample_products.csv'
		);
		await page.click( '.wc-actions .button-next' );
		await page.waitForSelector( '.wc-importer-mapping-table' );
		await page.select(
			'.wc-importer-mapping-table tr:nth-child(29) select',
			''
		);
		await page.click( '.wc-actions .button-next' );
		await page.waitForXPath(
			"//*[@class='woocommerce-importer-done' and contains(., 'Import complete! ')]"
		);
		await switchUserToTest();
	}
}

/**
 * Adds an event listener to the page to handle additions of page event
 * handlers, to assure that they are removed at test teardown.
 */
function capturePageEventsForTearDown() {
	page.on( 'newListener', ( eventName, listener ) => {
		pageEvents.push( [ eventName, listener ] );
	} );
}

/**
 * Removes all bound page event handlers.
 */
function removePageEvents() {
	pageEvents.forEach( ( [ eventName, handler ] ) => {
		page.removeListener( eventName, handler );
	} );
}

/**
 * Adds a page event handler to emit uncaught exception to process if one of
 * the observed console logging types is encountered.
 */
function observeConsoleLogging() {
	page.on( 'console', ( message ) => {
		const type = message.type();
		if ( ! OBSERVED_CONSOLE_MESSAGE_TYPES.hasOwnProperty( type ) ) {
			return;
		}

		let text = message.text();

		// An exception is made for _blanket_ deprecation warnings: Those
		// which log regardless of whether a deprecated feature is in use.
		if ( text.includes( 'This is a global warning' ) ) {
			return;
		}

		// A chrome advisory warning about SameSite cookies is informational
		// about future changes, tracked separately for improvement in core.
		//
		// See: https://core.trac.wordpress.org/ticket/37000
		// See: https://www.chromestatus.com/feature/5088147346030592
		// See: https://www.chromestatus.com/feature/5633521622188032
		if (
			text.includes( 'A cookie associated with a cross-site resource' )
		) {
			return;
		}

		// Viewing posts on the front end can result in this error, which
		// has nothing to do with Gutenberg.
		if ( text.includes( 'net::ERR_UNKNOWN_URL_SCHEME' ) ) {
			return;
		}

		// Network errors are ignored only if we are intentionally testing
		// offline mode.
		if (
			text.includes( 'net::ERR_INTERNET_DISCONNECTED' ) &&
			isOfflineMode()
		) {
			return;
		}

		// As of WordPress 5.3.2 in Chrome 79, navigating to the block editor
		// (Posts > Add New) will display a console warning about
		// non - unique IDs.
		// See: https://core.trac.wordpress.org/ticket/23165
		if ( text.includes( 'elements with non-unique id #_wpnonce' ) ) {
			return;
		}

		// Ignore all JQMIGRATE (jQuery migrate) deprecation warnings.
		if ( text.includes( 'JQMIGRATE' ) ) {
			return;
		}

		const logFunction = OBSERVED_CONSOLE_MESSAGE_TYPES[ type ];

		// As of Puppeteer 1.6.1, `message.text()` wrongly returns an object of
		// type JSHandle for error logging, instead of the expected string.
		//
		// See: https://github.com/GoogleChrome/puppeteer/issues/3397
		//
		// The recommendation there to asynchronously resolve the error value
		// upon a console event may be prone to a race condition with the test
		// completion, leaving a possibility of an error not being surfaced
		// correctly. Instead, the logic here synchronously inspects the
		// internal object shape of the JSHandle to find the error text. If it
		// cannot be found, the default text value is used instead.
		text = get(
			message.args(),
			[ 0, '_remoteObject', 'description' ],
			text
		);

		// Disable reason: We intentionally bubble up the console message
		// which, unless the test explicitly anticipates the logging via
		// @wordpress/jest-console matchers, will cause the intended test
		// failure.

		// eslint-disable-next-line no-console
		console[ logFunction ]( text );
	} );
}

// Before every test suite run, delete all content created by the test. This ensures
// other posts/comments/etc. aren't dirtying tests and tests don't depend on
// each other's side-effects.
beforeAll( async () => {
	capturePageEventsForTearDown();
	enablePageDialogAccept();
	observeConsoleLogging();
	await setupBrowser();
	await importSampleProducts();
	await page.emulateMediaFeatures( [
		{ name: 'prefers-reduced-motion', value: 'reduce' },
	] );
} );

afterEach( async () => {
	await setupBrowser();
} );

afterAll( () => {
	removePageEvents();
} );
