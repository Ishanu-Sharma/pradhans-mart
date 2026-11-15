// Starter catalogue, loaded only when the database has no products.
// Prices are set equal to a recent MRP for each pack size and MUST be checked against
// your supplier invoices and the packs on your shelf before launch (store.json launch.catalogVerified).
// Every brand below was founded in India and is owned by an Indian company or cooperative.
// "packer" is left empty: copy the manufacturer or packer name and address from each pack
// (Legal Metrology (Packaged Commodities) Rules, 2011).

export const categories = [
  { id: 'dairy', name: 'Dairy and breakfast' },
  { id: 'staples', name: 'Atta, rice, dal and oil' },
  { id: 'snacks', name: 'Snacks and biscuits' },
  { id: 'beverages', name: 'Tea and drinks' },
  { id: 'personal', name: 'Personal care' },
  { id: 'household', name: 'Household' }
];

const p = (id, name, brand, brandOwner, category, netQuantity, mrp, stock) => ({
  id, name, brand, brandOwner, category, netQuantity, mrp, price: mrp, stock,
  countryOfOrigin: 'India', packer: '', indianBrandConfirmed: true, active: true
});

export const seedProducts = [
  p('amul-butter-100g', 'Amul Butter', 'Amul', 'Gujarat Cooperative Milk Marketing Federation Ltd', 'dairy', '100 g', 62, 40),
  p('amul-taaza-500ml', 'Amul Taaza Toned Milk', 'Amul', 'Gujarat Cooperative Milk Marketing Federation Ltd', 'dairy', '500 ml', 28, 60),
  p('purabi-paneer-200g', 'Purabi Paneer', 'Purabi', 'West Assam Milk Producers’ Cooperative Union Ltd', 'dairy', '200 g', 90, 25),
  p('mother-dairy-dahi-400g', 'Mother Dairy Classic Dahi', 'Mother Dairy', 'Mother Dairy Fruit and Vegetable Pvt Ltd', 'dairy', '400 g', 50, 30),

  p('aashirvaad-atta-5kg', 'Aashirvaad Shudh Chakki Atta', 'Aashirvaad', 'ITC Ltd', 'staples', '5 kg', 265, 30),
  p('tata-salt-1kg', 'Tata Salt', 'Tata Salt', 'Tata Consumer Products Ltd', 'staples', '1 kg', 28, 80),
  p('tata-sampann-toor-1kg', 'Tata Sampann Unpolished Toor Dal', 'Tata Sampann', 'Tata Consumer Products Ltd', 'staples', '1 kg', 190, 25),
  p('india-gate-basmati-1kg', 'India Gate Basmati Rice Classic', 'India Gate', 'KRBL Ltd', 'staples', '1 kg', 210, 20),
  p('daawat-rozana-1kg', 'Daawat Rozana Basmati Rice', 'Daawat', 'LT Foods Ltd', 'staples', '1 kg', 110, 25),
  p('saffola-gold-1l', 'Saffola Gold Edible Oil', 'Saffola', 'Marico Ltd', 'staples', '1 l', 190, 25),
  p('patanjali-cow-ghee-1l', 'Patanjali Cow’s Ghee', 'Patanjali', 'Patanjali Ayurved Ltd', 'staples', '1 l', 650, 12),
  p('everest-garam-masala-100g', 'Everest Garam Masala', 'Everest', 'Everest Food Products Pvt Ltd', 'staples', '100 g', 90, 30),
  p('mdh-deggi-mirch-100g', 'MDH Deggi Mirch', 'MDH', 'Mahashian Di Hatti Pvt Ltd', 'staples', '100 g', 90, 30),

  p('parle-g-250g', 'Parle-G Glucose Biscuits', 'Parle', 'Parle Products Pvt Ltd', 'snacks', '250 g', 25, 70),
  p('good-day-cashew-200g', 'Good Day Cashew Cookies', 'Britannia', 'Britannia Industries Ltd', 'snacks', '200 g', 40, 45),
  p('bikaji-bhujia-400g', 'Bikaji Bikaneri Bhujia', 'Bikaji', 'Bikaji Foods International Ltd', 'snacks', '400 g', 110, 30),
  p('bingo-mad-angles-66g', 'Bingo Mad Angles Achaari Masti', 'Bingo', 'ITC Ltd', 'snacks', '66 g', 20, 60),
  p('dark-fantasy-75g', 'Sunfeast Dark Fantasy Choco Fills', 'Sunfeast', 'ITC Ltd', 'snacks', '75 g', 40, 40),

  p('tata-tea-gold-500g', 'Tata Tea Gold', 'Tata Tea', 'Tata Consumer Products Ltd', 'beverages', '500 g', 300, 30),
  p('wagh-bakri-500g', 'Wagh Bakri Premium Leaf Tea', 'Wagh Bakri', 'Gujarat Tea Processors and Packers Ltd', 'beverages', '500 g', 280, 25),
  p('paper-boat-aamras-250ml', 'Paper Boat Aamras', 'Paper Boat', 'Hector Beverages Pvt Ltd', 'beverages', '250 ml', 35, 40),

  p('dabur-red-200g', 'Dabur Red Toothpaste', 'Dabur', 'Dabur India Ltd', 'personal', '200 g', 120, 35),
  p('himalaya-neem-150ml', 'Himalaya Purifying Neem Face Wash', 'Himalaya', 'Himalaya Wellness Company', 'personal', '150 ml', 190, 25),
  p('parachute-500ml', 'Parachute Coconut Oil', 'Parachute', 'Marico Ltd', 'personal', '500 ml', 250, 25),
  p('cinthol-lime-100g', 'Cinthol Lime Soap', 'Cinthol', 'Godrej Consumer Products Ltd', 'personal', '100 g', 45, 50),
  p('boroplus-80ml', 'BoroPlus Antiseptic Cream', 'BoroPlus', 'Emami Ltd', 'personal', '80 ml', 135, 25),

  p('exo-bar-500g', 'Exo Dishwash Bar', 'Exo', 'Jyothy Labs Ltd', 'household', '500 g', 50, 40),
  p('ujala-supreme-250ml', 'Ujala Supreme Fabric Whitener', 'Ujala', 'Jyothy Labs Ltd', 'household', '250 ml', 70, 30),
  p('good-knight-refill', 'Good Knight Gold Flash Refill', 'Good Knight', 'Godrej Consumer Products Ltd', 'household', '45 ml', 85, 30),
  p('ghadi-detergent-1kg', 'Ghadi Detergent Powder', 'Ghadi', 'RSPL Ltd', 'household', '1 kg', 70, 30)
];
