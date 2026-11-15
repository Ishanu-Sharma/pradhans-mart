// Starter catalogue, loaded only when the database has no products.
// Every brand was founded in India and is owned by an Indian company or cooperative.
// Names and pack sizes follow the photo of each pack. Prices are set to an approximate MRP and
// MUST be checked against supplier invoices and the packs on the shelf before launch
// (store.json launch.catalogVerified). "packer" is filled in from each pack by the admin.
//
// Photos: Open Food Facts, Open Beauty Facts and Open Products Facts contributors, licensed under
// Creative Commons Attribution ShareAlike. We resized each photo and placed it on a white square;
// those versions are shared under the same licence. The credit link is the product's page there.

export const categories = [
  { id: 'dairy', name: 'Dairy and breakfast', image: '/assets/products/amul-butter-100g.jpg' },
  { id: 'staples', name: 'Atta, rice, dal and oil', image: '/assets/products/aashirvaad-atta-1kg.jpg' },
  { id: 'snacks', name: 'Snacks and biscuits', image: '/assets/products/bingo-mad-angles-66g.jpg' },
  { id: 'beverages', name: 'Tea and drinks', image: '/assets/products/tata-tea-gold-500g.jpg' },
  { id: 'personal', name: 'Personal care', image: '/assets/products/himalaya-neem-150ml.jpg' },
  { id: 'household', name: 'Household', image: '/assets/products/ujala-supreme-250ml.jpg' }
];

const OFF = 'https://world.openfoodfacts.org/product/';
const OBF = 'https://world.openbeautyfacts.org/product/';

const p = (id, name, brand, brandOwner, category, netQuantity, mrp, credit, defaultStock = 25) => ({
  id, name, brand, brandOwner, category, netQuantity, mrp, price: mrp, defaultStock,
  image: `/assets/products/${id}.jpg`, imageCredit: credit,
  countryOfOrigin: 'India', packer: '', indianBrandConfirmed: true, active: true
});

export const seedProducts = [
  p('amul-butter-100g', 'Amul Pasteurised Butter', 'Amul', 'Gujarat Cooperative Milk Marketing Federation Ltd', 'dairy', '100 g', 62, `${OFF}8901262010016`),
  p('amul-taaza-500ml', 'Amul Taaza Homogenised Toned Milk', 'Amul', 'Gujarat Cooperative Milk Marketing Federation Ltd', 'dairy', '500 ml', 34, `${OFF}8901262150217`),
  p('purabi-smart-milk-1l', 'Purabi Smart Milk', 'Purabi', 'West Assam Milk Producers’ Cooperative Union Ltd', 'dairy', '1 l', 66, `${OFF}8908012365785`),
  p('mother-dairy-ultimate-dahi-400g', 'Mother Dairy Ultimate Dahi', 'Mother Dairy', 'Mother Dairy Fruit and Vegetable Pvt Ltd', 'dairy', '400 g', 60, `${OFF}8901648097983`),

  p('aashirvaad-atta-1kg', 'Aashirvaad Shudh Chakki Atta', 'Aashirvaad', 'ITC Ltd', 'staples', '1 kg', 60, `${OFF}8901725121143`),
  p('tata-salt-1kg', 'Tata Salt', 'Tata Salt', 'Tata Consumer Products Ltd', 'staples', '1 kg', 28, `${OFF}8904043901015`),
  p('tata-sampann-toor-1kg', 'Tata Sampann Unpolished Toor Dal', 'Tata Sampann', 'Tata Consumer Products Ltd', 'staples', '1 kg', 190, `${OFF}8904043926216`),
  p('india-gate-dubar-1kg', 'India Gate Dubar Basmati Rice', 'India Gate', 'KRBL Ltd', 'staples', '1 kg', 140, `${OFF}0690225101134`),
  p('daawat-rozana-1kg', 'Daawat Rozana Super Basmati Rice', 'Daawat', 'LT Foods Ltd', 'staples', '1 kg', 110, `${OFF}8901537007123`),
  p('saffola-gold-1l', 'Saffola Gold Edible Oil', 'Saffola', 'Marico Ltd', 'staples', '1 l', 190, `${OFF}8901088017381`),
  p('patanjali-cow-ghee-500ml', 'Patanjali Cow’s Ghee', 'Patanjali', 'Patanjali Ayurved Ltd', 'staples', '500 ml', 340, `${OFF}8904109490545`, 12),
  p('everest-garam-masala-100g', 'Everest Garam Masala', 'Everest', 'Everest Food Products Pvt Ltd', 'staples', '100 g', 90, `${OFF}8901786101009`),
  p('mdh-deggi-mirch-100g', 'MDH Deggi Mirch', 'MDH', 'Mahashian Di Hatti Pvt Ltd', 'staples', '100 g', 90, `${OFF}8902167000034`),

  p('parle-g-250g', 'Parle-G Original Gluco Biscuits', 'Parle', 'Parle Products Pvt Ltd', 'snacks', '250 g', 25, `${OFF}8901719123870`, 40),
  p('good-day-cashew-200g', 'Britannia Good Day Cashew Cookies', 'Britannia', 'Britannia Industries Ltd', 'snacks', '200 g', 40, `${OFF}8901063093287`),
  p('bikaji-bhujia-400g', 'Bikaji Bikaneri Bhujia', 'Bikaji', 'Bikaji Foods International Ltd', 'snacks', '400 g', 110, `${OFF}8906005500052`),
  p('bingo-mad-angles-66g', 'Bingo Mad Angles Achaari Masti', 'Bingo', 'ITC Ltd', 'snacks', '66 g', 20, `${OFF}8901725017903`, 40),
  p('dark-fantasy-75g', 'Sunfeast Dark Fantasy Choco Fills', 'Sunfeast', 'ITC Ltd', 'snacks', '75 g', 40, `${OFF}8901725016159`),

  p('tata-tea-gold-500g', 'Tata Tea Gold', 'Tata Tea', 'Tata Consumer Products Ltd', 'beverages', '500 g', 300, `${OFF}8901052000906`),
  p('wagh-bakri-500g', 'Wagh Bakri Premium Leaf Tea', 'Wagh Bakri', 'Gujarat Tea Processors and Packers Ltd', 'beverages', '500 g', 280, `${OFF}8901747001546`),
  p('paper-boat-aamras-200ml', 'Paper Boat Aamras', 'Paper Boat', 'Hector Beverages Pvt Ltd', 'beverages', '200 ml', 30, `${OFF}8908001705448`),

  p('dabur-red-200g', 'Dabur Red Toothpaste', 'Dabur', 'Dabur India Ltd', 'personal', '200 g', 120, `${OBF}8901207052804`),
  p('patanjali-dant-kanti-200g', 'Patanjali Dant Kanti Natural Toothpaste', 'Patanjali', 'Patanjali Ayurved Ltd', 'personal', '200 g', 106, `${OBF}8904109450327`),
  p('himalaya-neem-150ml', 'Himalaya Purifying Neem Face Wash', 'Himalaya', 'Himalaya Wellness Company', 'personal', '150 ml', 190, `${OBF}8901138511784`),
  p('parachute-200ml', 'Parachute 100% Pure Coconut Oil', 'Parachute', 'Marico Ltd', 'personal', '200 ml', 105, `${OFF}8901088000345`),
  p('cinthol-lime-75g', 'Cinthol Lime Soap', 'Cinthol', 'Godrej Consumer Products Ltd', 'personal', '75 g', 35, `${OBF}8901023003622`),

  p('ujala-supreme-250ml', 'Ujala Supreme Fabric Whitener', 'Ujala', 'Jyothy Labs Ltd', 'household', '250 ml', 70, `${OFF}8902102194910`),
  p('good-knight-gold-flash-2-refills', 'Good Knight Gold Flash Refill, pack of 2', 'Good Knight', 'Godrej Consumer Products Ltd', 'household', '2 x 45 ml', 150, `${OFF}8901023019739`),
  p('odonil-gel-pocket', 'Odonil Gel Pocket, Wild Forest', 'Odonil', 'Dabur India Ltd', 'household', '10 g', 55, `${OFF}8901207043482`)
];
