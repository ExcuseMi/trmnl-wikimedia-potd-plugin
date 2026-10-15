# frozen_string_literal: true

# Picture of the day, run with `trmnlp test` from plugin/. No network: the feed and the metadata call are mocked
# (tests/fixtures). Four views, a landscape and a portrait picture, description on and off, on an OG (1-bit)
# and an X (v2) device.
require 'json'

RSpec.describe 'Wikimedia Commons Picture of the Day' do
  let(:atom) { File.read(File.join(__dir__, 'fixtures', 'potd.atom')) }
  let(:meta) { JSON.parse(File.read(File.join(__dir__, 'fixtures', 'extmetadata.json'))) }
  let(:custom_fields) { { 'mode' => 'today' } }

  # the same record with the picture's size set: wide for a landscape one, tall for a portrait one
  def mocks_for(width, height)
    m = JSON.parse(JSON.generate(meta))
    info = m['query']['pages'].values.first['imageinfo'].first
    info['width'] = width
    info['height'] = height
    { %r{featuredfeed} => { body: atom }, %r{action=query} => { json: m } }
  end

  PICTURES = { 'landscape' => [3000, 2000], 'portrait' => [2000, 3000] }.freeze
  VIEWS = %w[full half_horizontal half_vertical quadrant].freeze
  DEVICES = %w[og_png v2].freeze
  # the same words come out of the fixture on every device
  TITLE = /White teatfish/
  CREDIT = /Diego Delso/
  DESC = /This species of sea cucumber/

  def screen(view, device, shape, show)
    trmnl.render(view:, device:, mocks: mocks_for(*PICTURES[shape]),
                 custom_fields: custom_fields.merge('show_description' => show))
  end

  it_behaves_like 'a publishable recipe' do
    let(:mocks) { mocks_for(3000, 2000) }
  end

  PICTURES.each_key do |shape|
    VIEWS.each do |view|
      DEVICES.each do |device|
        %w[true false].each do |show|
          describe "#{view} #{shape} on #{device}, description #{show == 'true' ? 'on' : 'off'}" do
            let(:page) { screen(view, device, shape, show) }

            it 'never crops the picture' do
              fit = page.evaluate("getComputedStyle(document.querySelector('img.image')).objectFit")
              expect(fit).to eq('contain')
            end

            it 'shows or leaves out the description as set' do
              page.has_css?('img.image') # wait for the page
              if show == 'true' && %w[full half_horizontal].include?(view)
                expect(page).to have_text(DESC)
              elsif show == 'false'
                expect(page).to have_no_text(DESC)
              end
            end

            it 'shows title and credit where there is room for text' do
              next if view == 'quadrant' || show == 'false'

              expect(page).to have_text(TITLE)
              expect(page).to have_text(CREDIT)
            end

            it 'with the text off: only the picture and a credit box in a corner, no header, title, rule or column' do
              next unless show == 'false'

              page.has_css?('img.image') # wait for the page
              expect(page).to have_css('[data-credit]', text: CREDIT)
              expect(page).to have_no_text(TITLE)
              expect(page).to have_no_text('Picture of the day')
              expect(page).to have_no_css('.title_bar')
              expect(page).to have_no_css('[data-rule], .title, .description, .border--v-black, .border--h-black')
              # layout px: the screen can be zoomed, so rectangles are compared in their own (scaled) units
              box = page.evaluate(<<~JS)
                (() => {
                  const b = document.querySelector('[data-credit]'), t = b.firstElementChild, im = document.querySelector('img.image');
                  const ib = im.getBoundingClientRect(), r = b.getBoundingClientRect(), v = document.querySelector('.view').getBoundingClientRect();
                  const ratio = im.naturalWidth / im.naturalHeight;
                  const dw = Math.min(ib.width, ib.height * ratio), dh = Math.min(ib.height, ib.width / ratio);
                  const pic = { left: ib.left + (ib.width - dw) / 2, right: ib.right - (ib.width - dw) / 2, top: ib.top + (ib.height - dh) / 2, bottom: ib.bottom - (ib.height - dh) / 2 };
                  const overlap = r.left < pic.right - 1 && r.right > pic.left + 1 && r.top < pic.bottom - 1 && r.bottom > pic.top + 1;
                  const scale = ib.width / im.clientWidth;
                  return { bg: getComputedStyle(b).backgroundColor, fg: getComputedStyle(t).color, overlap,
                           inside: r.left >= v.left - 1 && r.right <= v.right + 1 && r.top >= v.top - 1 && r.bottom <= v.bottom + 1,
                           sideRoom: (ib.width - dw) / 2 / scale, underRoom: (ib.height - dh) / 2 / scale, boxH: r.height / scale,
                           atCorner: Math.abs(r.right - pic.right) < 2 && Math.abs(r.bottom - pic.bottom) < 2,
                           lines: Math.round(t.offsetHeight / (parseFloat(getComputedStyle(t).lineHeight) || 16)),
                           texts: [...document.querySelectorAll('.view *')].filter((e) => e.tagName !== 'SCRIPT' && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())).length };
                })()
              JS
              expect(box['bg']).to eq('rgb(255, 255, 255)')
              expect(box['fg']).to eq('rgb(0, 0, 0)')
              expect(box['inside']).to be(true)
              expect(box['lines']).to be <= 3
              # the credit avoids the photo when a margin of the size it needs exists; else it sits on the photo's corner
              if box['sideRoom'] >= 140 || box['underRoom'] >= box['boxH']
                expect(box['overlap']).to be(false)
              else
                expect(box['atCorner']).to be(true)
              end
              expect(box['texts']).to eq(1)
            end

            it 'with the text off, a landscape picture in half_vertical has its credit under the picture, in half_horizontal beside it' do
              next unless show == 'false' && shape == 'landscape' && %w[half_vertical half_horizontal].include?(view)

              page.has_css?('img.image')
              r = page.evaluate(<<~JS)
                (() => {
                  const b = document.querySelector('[data-credit]').getBoundingClientRect(), im = document.querySelector('img.image').getBoundingClientRect();
                  const ratio = document.querySelector('img.image').naturalWidth / document.querySelector('img.image').naturalHeight;
                  const dw = Math.min(im.width, im.height * ratio), dh = Math.min(im.height, im.width / ratio);
                  return { under: b.top >= im.top + (im.height + dh) / 2 - 1, beside: b.left >= im.left + (im.width + dw) / 2 - 1 };
                })()
              JS
              expect(view == 'half_vertical' ? r['under'] : r['beside']).to be(true)
            end

            it 'has no overflow and no page errors' do
              expect(page).to have_no_overflow
              expect(page).to have_no_problems
            end

            it 'sets the description in a native framework size, never scaled' do
              page.has_css?('img.image') # wait for the page
              next unless show == 'true'

              # a probe with the same class, outside the description box, is what "native" means on this device
              r = page.evaluate(<<~JS)
                (() => {
                  const d = document.querySelector('.description');
                  if (!d) return null;
                  const probe = document.createElement('span');
                  probe.className = 'description';
                  document.querySelector('.view').appendChild(probe);
                  const native = getComputedStyle(probe).fontSize;
                  probe.remove();
                  const chain = [];
                  for (let e = d; e; e = e.parentElement) if (e.style.fontSize || e.style.transform || e.hasAttribute('data-content-limiter')) chain.push(e.className);
                  const b = d.getBoundingClientRect();
                  return { size: getComputedStyle(d).fontSize, native, chain, whole: Number.isInteger(b.x) ? '' : String(b.x) };
                })()
              JS
              next if r.nil? # quadrant and half_vertical may have no room for it

              expect(r['size']).to eq(r['native'])
              expect(r['chain']).to eq([])
              # a column edge on a half pixel in x dithers the glyphs to hatching on 1-bit (seen with a 38cqw column)
              expect(r['whole']).to eq('') if device == 'og_png'
            end

            if device == 'og_png'
              it 'draws no grey: classes, inline colours, computed text, background (pill) and rule colours' do
                html = page.html
                expect(html).not_to match(/\b(text|bg|label|border--[hv])-(-)?(gray|grey|[1-7][05])\b|--gray|--grey/)
                expect(html).not_to match(/style="[^"]*(color|background)[^"]*#(?!000\b|000000|fff\b|ffffff)/i)
                greys = page.evaluate(<<~JS)
                  [...document.querySelectorAll('body *')].flatMap((e) => {
                    const c = getComputedStyle(e), ok = (v) => /^(rgb\\(0, 0, 0\\)|rgb\\(255, 255, 255\\)|rgba\\(0, 0, 0, 0\\))$/.test(v);
                    const bad = [];
                    if (e.childNodes.length && [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && !ok(c.color)) bad.push(e.className + ' color ' + c.color);
                    if (!ok(c.backgroundColor) && c.backgroundColor !== 'rgb(255, 255, 255)') bad.push(e.className + ' background ' + c.backgroundColor);
                    for (const s of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(c['border' + s + 'Width']) > 0 && !ok(c['border' + s + 'Color'])) bad.push(e.className + ' border ' + c['border' + s + 'Color']);
                    return bad;
                  })
                JS
                expect(greys).to eq([])
              end
            end
          end
        end
      end
    end
  end

  it 'picture_fit cover fills the picture area, contain (the default) never crops' do
    cover = trmnl.render(view: 'full', device: 'v2', mocks: mocks_for(3000, 2000),
                         custom_fields: custom_fields.merge('show_description' => 'true', 'picture_fit' => 'cover'))
    expect(cover.evaluate("getComputedStyle(document.querySelector('img.image')).objectFit")).to eq('cover')
    plain = trmnl.render(view: 'full', device: 'v2', mocks: mocks_for(3000, 2000), custom_fields: custom_fields.merge('show_description' => 'true'))
    expect(plain.evaluate("getComputedStyle(document.querySelector('img.image')).objectFit")).to eq('contain')
  end

  # the reviewer's X render showed no text column: with the text on, the X full view has title, credit and description,
  # and the picture still takes most of the height
  %w[landscape portrait].each do |shape|
    it "X full view, #{shape} picture, text on: title, credit and description are there, the picture is not squeezed" do
      page = screen('full', 'v2', shape, 'true')
      page.has_css?('img.image')
      expect(page).to have_text(TITLE)
      expect(page).to have_text(CREDIT)
      expect(page).to have_text(DESC)
      r = page.evaluate("(() => { const i = document.querySelector('img.image').getBoundingClientRect(), v = document.querySelector('.view').getBoundingClientRect(); return { h: i.height / v.height, w: i.width / v.width }; })()")
      expect(shape == 'landscape' ? r['h'] : r['w']).to be > 0.6
      expect(page).to have_no_overflow
    end
  end

  it 'draws a rule between the picture and the text of a landscape picture' do
    page = screen('full', 'og_png', 'landscape', 'true')
    expect(page).to have_css('[data-rule=picture]')
  end

  # The day modes: the position label is the date (archive) or "n / N" over the years (on_this_day, header = that date)
  describe 'the day modes' do
    let(:day_mocks) do
      {
        %r{titles=Template} => { json: JSON.parse(File.read(File.join(__dir__, 'fixtures', 'archive-2015-06-01.json'))) },
        %r{titles=File} => { json: JSON.parse(File.read(File.join(__dir__, 'fixtures', 'mahonia-info.json'))) },
        %r{wbgetentities} => { json: { 'entities' => {} } }
      }
    end

    def day_screen(mode)
      trmnl.render(view: 'full', device: 'og_png', mocks: day_mocks, custom_fields: { 'mode' => mode, 'show_description' => 'true' })
    end

    it 'archive: the date is the position, the header carries no second date' do
      page = day_screen('archive')
      expect(page).to have_css('.label--inverted', text: /\A\d{1,2} [A-Z][a-z]{2} \d{4}\z/)
      expect(page).to have_no_overflow
      expect(page).to have_no_problems
    end

    it 'on_this_day: the header shows the date, the position is n / N over the years' do
      page = day_screen('on_this_day')
      expect(page).to have_css('.label--inverted', text: %r{\A1 / \d+\z})
      expect(page).to have_text(/\b[A-Z][a-z]{2} 2005\b/)
      expect(page).to have_no_problems
    end
  end
end
